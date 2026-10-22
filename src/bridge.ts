import { CommandError, type Command, type CommandResult } from './protocol';
import type { DiagramController } from './editor/controller';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type Activity = { id: string; label: string; time: string; error: boolean };

export class BrowserBridge {
  private socket?: WebSocket;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;

  constructor(
    private controller: DiagramController,
    private token: string,
    private onStatus: (status: ConnectionStatus, error?: string) => void,
    private onActivity: (activity: Activity) => void,
  ) {}

  connect() {
    if (this.stopped) return;
    this.onStatus(this.attempts ? 'reconnecting' : 'connecting');
    const url = new URL('/api/bridge', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'hello', token: this.token, diagramId: this.controller.diagramId }));
    };
    socket.onmessage = (event) => {
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
          response.result = this.controller.execute(command);
        } catch (error) {
          response.error = error instanceof CommandError
            ? { code: error.code, message: error.message }
            : { code: 'editor_error', message: 'The editor could not complete this operation.' };
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
        this.onActivity({
          id: command.id,
          label: response.error?.message ?? (command.tool === 'get_diagram' ? 'Agent read the diagram' : 'Agent updated the diagram'),
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          error: Boolean(response.error),
        });
      }
    };
    socket.onclose = (event) => {
      if (this.stopped) return;
      if (event.code === 1008) {
        this.stopped = true;
        this.token = '';
        this.onStatus('disconnected', event.reason || 'Connection was rejected. Check the token.');
        return;
      }
      this.onStatus('reconnecting', 'Connection interrupted. Reconnecting…');
      const delay = Math.min(1000 * 2 ** this.attempts++, 10000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect() {
    this.stopped = true;
    this.token = '';
    clearTimeout(this.timer);
    this.socket?.close(1000, 'Disconnected by user');
    this.onStatus('disconnected');
  }
}
