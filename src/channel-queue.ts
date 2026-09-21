export type ChannelTask = () => Promise<void>;
export type ChannelTaskErrorHandler = (channelId: string, error: unknown) => Promise<void>;

/** Runs each channel's asynchronous input in order while letting separate channels proceed independently. */
export class ChannelQueue {
  private pending = new Map<string, Promise<void>>();

  constructor(private onError: ChannelTaskErrorHandler) {}

  enqueue(channelId: string, task: ChannelTask): Promise<void> {
    const previous = this.pending.get(channelId) ?? Promise.resolve();
    const next = previous.then(task, task).catch(async (err) => {
      try {
        await this.onError(channelId, err);
      } catch (reportErr) {
        console.error("[queue] failed to report task error:", reportErr);
      }
    });
    this.pending.set(channelId, next);
    void next.then(() => {
      if (this.pending.get(channelId) === next) this.pending.delete(channelId);
    });
    return next;
  }
}
