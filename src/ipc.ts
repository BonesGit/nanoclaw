import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import type { SessionChannel } from './channels/session.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  sessionChannel?: SessionChannel | null;
}

function writeIpcResponse(
  groupFolder: string,
  requestId: string,
  payload: object,
): void {
  const responseDir = path.join(resolveGroupIpcPath(groupFolder), 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const file = path.join(responseDir, `${requestId}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For session operations
    requestId?: string;
    memberIds?: string[];
    groupId?: string;
    withHistory?: boolean;
    alsoRemoveMessages?: boolean;
    sessionId?: string;
    conversationId?: string;
    limit?: number;
    attachment?: {
      url: string;
      key: string;
      digest: string;
      fileName?: string;
    };
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'session_create_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_create_group attempt blocked',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: 'Main group only',
          });
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_create_group: Session channel not available',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: 'Session channel not available',
          });
        break;
      }
      if (data.name && data.memberIds && data.requestId) {
        try {
          const groupId = await deps.sessionChannel.createGroup(
            data.name,
            data.memberIds,
          );
          writeIpcResponse(sourceGroup, data.requestId, {
            success: true,
            groupId,
          });
          logger.info(
            { sourceGroup, groupId },
            'Session group created via IPC',
          );
        } catch (err) {
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: String(err),
          });
        }
      }
      break;

    case 'session_add_members':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_add_members attempt blocked',
        );
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_add_members: Session channel not available',
        );
        break;
      }
      if (data.groupId && data.memberIds) {
        try {
          await deps.sessionChannel.addGroupMembers(
            data.groupId,
            data.memberIds,
            { withHistory: data.withHistory },
          );
          logger.info(
            { sourceGroup, groupId: data.groupId },
            'Session members added via IPC',
          );
        } catch (err) {
          logger.error({ sourceGroup, err }, 'session_add_members failed');
        }
      }
      break;

    case 'session_remove_members':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_remove_members attempt blocked',
        );
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_remove_members: Session channel not available',
        );
        break;
      }
      if (data.groupId && data.memberIds) {
        try {
          await deps.sessionChannel.removeGroupMembers(
            data.groupId,
            data.memberIds,
            { alsoRemoveMessages: data.alsoRemoveMessages },
          );
          logger.info(
            { sourceGroup, groupId: data.groupId },
            'Session members removed via IPC',
          );
        } catch (err) {
          logger.error({ sourceGroup, err }, 'session_remove_members failed');
        }
      }
      break;

    case 'session_leave_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_leave_group attempt blocked',
        );
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_leave_group: Session channel not available',
        );
        break;
      }
      if (data.groupId) {
        try {
          await deps.sessionChannel.leaveGroup(data.groupId);
          logger.info(
            { sourceGroup, groupId: data.groupId },
            'Session group left via IPC',
          );
        } catch (err) {
          logger.error({ sourceGroup, err }, 'session_leave_group failed');
        }
      }
      break;

    case 'session_block_contact':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_block_contact attempt blocked',
        );
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_block_contact: Session channel not available',
        );
        break;
      }
      if (data.sessionId) {
        try {
          await deps.sessionChannel.blockContact(data.sessionId);
          logger.info(
            { sourceGroup, sessionId: data.sessionId },
            'Session contact blocked via IPC',
          );
        } catch (err) {
          logger.error({ sourceGroup, err }, 'session_block_contact failed');
        }
      }
      break;

    case 'session_unblock_contact':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_unblock_contact attempt blocked',
        );
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_unblock_contact: Session channel not available',
        );
        break;
      }
      if (data.sessionId) {
        try {
          await deps.sessionChannel.unblockContact(data.sessionId);
          logger.info(
            { sourceGroup, sessionId: data.sessionId },
            'Session contact unblocked via IPC',
          );
        } catch (err) {
          logger.error({ sourceGroup, err }, 'session_unblock_contact failed');
        }
      }
      break;

    case 'session_set_display_name':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized session_set_display_name attempt blocked',
        );
        break;
      }
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_set_display_name: Session channel not available',
        );
        break;
      }
      if (data.name) {
        try {
          await deps.sessionChannel.setDisplayName(data.name);
          logger.info(
            { sourceGroup, name: data.name },
            'Session display name updated via IPC',
          );
        } catch (err) {
          logger.error({ sourceGroup, err }, 'session_set_display_name failed');
        }
      }
      break;

    case 'session_get_messages':
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_get_messages: Session channel not available',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: 'Session channel not available',
          });
        break;
      }
      if (data.conversationId && data.requestId) {
        try {
          const messages = await deps.sessionChannel.getMessages(
            data.conversationId,
            { limit: data.limit },
          );
          writeIpcResponse(sourceGroup, data.requestId, {
            success: true,
            messages,
          });
          logger.info(
            { sourceGroup, conversationId: data.conversationId },
            'Session messages fetched via IPC',
          );
        } catch (err) {
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: String(err),
          });
        }
      }
      break;

    case 'session_download_attachment':
      if (!deps.sessionChannel?.isConnected()) {
        logger.warn(
          { sourceGroup },
          'session_download_attachment: Session channel not available',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: 'Session channel not available',
          });
        break;
      }
      if (data.attachment && data.requestId) {
        try {
          const groupDir = resolveGroupFolderPath(sourceGroup);
          const attachmentsDir = path.join(groupDir, 'attachments');
          fs.mkdirSync(attachmentsDir, { recursive: true });
          const hostPath = await deps.sessionChannel.downloadAttachment(
            data.attachment,
            attachmentsDir,
          );
          const relPath = path.relative(groupDir, hostPath);
          const containerPath = path.posix.join(
            '/workspace/group',
            relPath.split(path.sep).join(path.posix.sep),
          );
          writeIpcResponse(sourceGroup, data.requestId, {
            success: true,
            localPath: containerPath,
          });
          logger.info(
            { sourceGroup, containerPath },
            'Session attachment downloaded via IPC',
          );
        } catch (err) {
          writeIpcResponse(sourceGroup, data.requestId, {
            success: false,
            error: String(err),
          });
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
