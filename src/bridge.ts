import { CommandError, type Command, type CommandResult } from './protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type Activity = { id: string; label: string; time: string; error: boolean };

export class BrowserBridge {
  private socket?: WebSocket;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;

  constructor(
    private controller: { readonly diagramId: string; execute: (command: Command) => unknown | Promise<unknown> },
    private prepare: () => Promise<void>,
    private onStatus: (status: ConnectionStatus, error?: string) => void,
    private onActivity: (activity: Activity) => void,
  ) {}

  async connect() {
    if (this.stopped) return;
    this.onStatus(this.attempts ? 'reconnecting' : 'connecting');
    try { await this.prepare(); } catch (error) {
      if (this.stopped) return;
      this.onStatus('reconnecting', error instanceof Error ? error.message : 'Could not reconnect.');
      this.timer = setTimeout(() => void this.connect(), Math.min(1000 * 2 ** this.attempts++, 10000));
      return;
    }
    if (this.stopped) return;
    const url = new URL('/api/bridge', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'hello', diagramId: this.controller.diagramId, capabilities: ['hosted_exports_v1'] }));
    };
    socket.onmessage = async (event) => {
      if (this.stopped || this.socket !== socket) return;
      let message: { type: string };
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') {
        this.attempts = 0;
        this.onStatus('connected');
      } else if (message.type === 'command') {
        const command = message as Command;
        const response: CommandResult = { type: 'result', id: command.id };
        try {
          response.result = await this.controller.execute(command);
        } catch (error) {
          response.error = error instanceof CommandError
            ? { code: error.code, message: error.message }
            : { code: 'editor_error', message: 'The editor could not complete this operation.' };
        }
        let payload = JSON.stringify(response);
        if (new TextEncoder().encode(payload).byteLength > 3 * 1024 * 1024) {
          response.result = undefined;
          response.error = { code: 'response_too_large', message: 'This response is too large. Use export_diagram and read_export to retrieve the scene in chunks; inspect the library before retrying a write.' };
          payload = JSON.stringify(response);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
        const activityLabel = command.tool === '__hosted_export_job' ? 'Preparing hosted export'
          : command.tool === '__cancel_hosted_export' ? 'Cancelling hosted export'
          : `Agent: ${command.tool.replaceAll('_', ' ')}`;
        this.onActivity({
          id: command.id,
          label: response.error?.message ?? activityLabel,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          error: Boolean(response.error),
        });
      }
    };
    socket.onclose = (event) => {
      if (this.stopped) return;
      if (event.code === 1008) {
        this.stopped = true;
        this.onStatus('disconnected', event.reason || 'Connection was rejected. Reconnect this browser.');
        return;
      }
      this.onStatus('reconnecting', 'Connection interrupted. Reconnecting…');
      const delay = Math.min(1000 * 2 ** this.attempts++, 10000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close(1000, 'Disconnected by user');
    this.onStatus('disconnected');
  }
}
