/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForResponse(requestId: string, timeoutMs = 15000): Promise<unknown> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const data = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
      fs.rmSync(responsePath);
      return data;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for response to request ${requestId}`);
}

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'session_create_group',
  'Create a new Session GroupV2 group. Main group only. Returns the new group\'s pubkey (starts with "03").',
  {
    name: z.string().describe('Display name for the group'),
    member_ids: z.array(z.string()).describe('Array of Session IDs to add as members'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can create Session groups.' }], isError: true };
    }
    const requestId = newRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'session_create_group',
      name: args.name,
      memberIds: args.member_ids,
      requestId,
      timestamp: new Date().toISOString(),
    });
    try {
      const response = await waitForResponse(requestId) as { success: boolean; groupId?: string; error?: string };
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to create group: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Group created. Group ID: ${response.groupId}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'session_add_members',
  'Add members to a Session group. Main group only.',
  {
    group_id: z.string().describe('The group pubkey (starts with "03")'),
    member_ids: z.array(z.string()).describe('Array of Session IDs to add'),
    with_history: z.boolean().optional().describe('Whether to share message history with new members'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage Session groups.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'session_add_members',
      groupId: args.group_id,
      memberIds: args.member_ids,
      withHistory: args.with_history,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Add members request sent.' }] };
  },
);

server.tool(
  'session_remove_members',
  'Remove members from a Session group. Main group only.',
  {
    group_id: z.string().describe('The group pubkey (starts with "03")'),
    member_ids: z.array(z.string()).describe('Array of Session IDs to remove'),
    also_remove_messages: z.boolean().optional().describe('Whether to also remove their messages'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage Session groups.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'session_remove_members',
      groupId: args.group_id,
      memberIds: args.member_ids,
      alsoRemoveMessages: args.also_remove_messages,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Remove members request sent.' }] };
  },
);

server.tool(
  'session_leave_group',
  'Leave a Session group. Main group only.',
  {
    group_id: z.string().describe('The group pubkey (starts with "03")'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can leave Session groups.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'session_leave_group',
      groupId: args.group_id,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Leave group request sent.' }] };
  },
);

server.tool(
  'session_get_conversations',
  'Get a snapshot of all known Session conversations. Returns the list written before this agent invocation.',
  {},
  async () => {
    const convoFile = path.join(IPC_DIR, 'session_conversations.json');
    try {
      if (!fs.existsSync(convoFile)) {
        return { content: [{ type: 'text' as const, text: 'No Session conversations snapshot found. Session channel may not be active.' }] };
      }
      const data = JSON.parse(fs.readFileSync(convoFile, 'utf-8'));
      const convos = data.conversations as unknown[];
      if (!convos || convos.length === 0) {
        return { content: [{ type: 'text' as const, text: `No conversations found (snapshot from ${data.lastSync as string}).` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ conversations: convos, lastSync: data.lastSync }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error reading conversations: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'session_get_messages',
  'Fetch message history for a Session conversation.',
  {
    conversation_id: z.string().describe('The Session conversation ID (Session ID or group pubkey)'),
    limit: z.number().optional().describe('Maximum number of messages to return'),
  },
  async (args) => {
    const requestId = newRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'session_get_messages',
      conversationId: args.conversation_id,
      limit: args.limit,
      requestId,
      timestamp: new Date().toISOString(),
    });
    try {
      const response = await waitForResponse(requestId) as { success: boolean; messages?: unknown[]; error?: string };
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get messages: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response.messages, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'session_download_attachment',
  'Download and decrypt a Session message attachment. Returns the local path inside the container where the file was saved.',
  {
    url: z.string().describe('Attachment URL'),
    key: z.string().describe('Encryption key'),
    digest: z.string().describe('Attachment digest'),
    file_name: z.string().optional().describe('Optional file name'),
  },
  async (args) => {
    const requestId = newRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'session_download_attachment',
      attachment: { url: args.url, key: args.key, digest: args.digest, fileName: args.file_name },
      requestId,
      timestamp: new Date().toISOString(),
    });
    try {
      const response = await waitForResponse(requestId) as { success: boolean; localPath?: string; error?: string };
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to download attachment: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Attachment downloaded to: ${response.localPath}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'session_block_contact',
  'Block a Session ID. Main group only.',
  {
    session_id: z.string().describe('The Session ID to block'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can block Session contacts.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'session_block_contact',
      sessionId: args.session_id,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Block request sent for ${args.session_id}.` }] };
  },
);

server.tool(
  'session_unblock_contact',
  'Unblock a Session ID. Main group only.',
  {
    session_id: z.string().describe('The Session ID to unblock'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can unblock Session contacts.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'session_unblock_contact',
      sessionId: args.session_id,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Unblock request sent for ${args.session_id}.` }] };
  },
);

server.tool(
  'session_set_display_name',
  "Update the bot's Session display name. Main group only.",
  {
    name: z.string().describe('The new display name'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: "Only the main group can update the bot's Session display name." }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'session_set_display_name',
      name: args.name,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Display name update requested: "${args.name}".` }] };
  },
);

server.tool(
  'session_send_file',
  'Send a file to a Session conversation. The file must already exist under /workspace/group/ (e.g. an attachment you previously saved or generated).',
  {
    chat_jid: z.string().describe('The session: prefixed JID of the conversation to send to'),
    file_path: z.string().describe('Absolute container path to the file, must start with /workspace/group/'),
    content_type: z.string().describe('MIME type of the file (e.g. "image/png", "application/pdf", "audio/ogg")'),
    file_name: z.string().optional().describe('File name to show in the message (defaults to the file\'s base name)'),
    caption: z.string().optional().describe('Optional caption text to accompany the file'),
  },
  async (args) => {
    const targetGroup = isMain ? null : groupFolder;
    writeIpcFile(TASKS_DIR, {
      type: 'session_send_file',
      chatJid: args.chat_jid,
      filePath: args.file_path,
      contentType: args.content_type,
      fileName: args.file_name,
      caption: args.caption,
      groupFolder: targetGroup ?? groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'File send request submitted.' }] };
  },
);

server.tool(
  'session_send_reply',
  'Send a quoted reply to a specific Session message.',
  {
    chat_jid: z.string().describe('The session: prefixed JID of the conversation'),
    text: z.string().describe('The reply text'),
    quote_id: z.string().describe('ID of the message to quote'),
    quote_author: z.string().describe('Session ID of the original message author'),
    quote_text: z.string().describe('Text of the original message being quoted'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'session_send_reply',
      chatJid: args.chat_jid,
      text: args.text,
      quote: { id: args.quote_id, author: args.quote_author, text: args.quote_text },
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Reply sent.' }] };
  },
);

server.tool(
  'session_get_conversation',
  'Fetch metadata for a specific Session conversation (display name, member list, etc.).',
  {
    conversation_id: z.string().describe('The Session conversation ID (Session ID or group pubkey starting with "03")'),
  },
  async (args) => {
    const requestId = newRequestId();
    writeIpcFile(TASKS_DIR, {
      type: 'session_get_conversation',
      conversationId: args.conversation_id,
      requestId,
      timestamp: new Date().toISOString(),
    });
    try {
      const response = await waitForResponse(requestId) as { success: boolean; conversation?: unknown; error?: string };
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to get conversation: ${response.error}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response.conversation, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
