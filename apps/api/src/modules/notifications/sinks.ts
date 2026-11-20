import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../../platform/logger';
import { render, type Message } from './templates';

/** Final delivery step (provider adapters IF-NTF-001/002 replace these in Phase 7). */
export interface MessageSink {
  deliver(message: Message): Promise<void>;
}

/**
 * Development sink: appends each rendered message as a JSON line, so developers
 * can read OTPs and links without SMS/email providers. Never used in production.
 */
export class FileMessageSink implements MessageSink {
  constructor(private readonly path: string) {}

  async deliver(message: Message): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const { subject, text } = render(message);
    await appendFile(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), channel: message.channel, to: message.to, subject, text })}\n`,
    );
  }
}

/** Development sink that writes rendered messages to the log. */
export class LogMessageSink implements MessageSink {
  constructor(private readonly logger: Logger) {}

  async deliver(message: Message): Promise<void> {
    const { subject, text } = render(message);
    this.logger.info(
      { devMessage: { channel: message.channel, to: message.to, subject, text } },
      'dev message (not sent)',
    );
  }
}
