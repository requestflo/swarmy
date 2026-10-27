import { tooLargeWords } from '@swarmy/core';

/**
 * Why a download stopped, in the words the Backups dialog shows (it polls
 * `backups.downloadStatus`; a browser download that breaks off can only say
 * "network error"). Pure.
 */
export function downloadErrorWords(code: string, message: string, maxBytes: number): string {
  switch (code) {
    case 'E_TOO_LARGE':
      // The agent's own ceiling names itself; otherwise it was this download's cap.
      return message.includes('SWARMY_SNAPSHOT_DOWNLOAD_MAX_BYTES') ? `The download stopped: it went ${message}.` : tooLargeWords(maxBytes);
    case 'E_CANCELED':
      return 'The download was stopped before it finished.';
    case 'E_STALLED':
      return 'The download stopped because nothing was moving. Start it again.';
    case 'E_NOT_FOUND':
      return 'That path isn’t in this save.';
    case 'E_AGENT_GONE':
      return 'The server reading this save disconnected partway. Start the download again.';
    case 'E_DISABLED':
    case 'E_BUSY':
      return `The server reading this save said no: ${message}.`;
    case 'E_SOURCE':
      return `restic couldn’t read the save: ${message}`;
    default:
      return `The download broke off: ${message}`;
  }
}
