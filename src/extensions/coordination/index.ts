// Interface only. No scheduler is constructed or called by the gateway.
export interface SpeakRequest {
  route: string;
  account: string;
  principal: string;
  conversation: { kind: 'group' | 'private'; id: string };
  generation: string;
}
export type SpeakDecision = { granted: true; expiresAt: number } | { granted: false; reason: string };
export interface Coordination {
  requestSpeak(request: SpeakRequest): Promise<SpeakDecision>;
  release(request: SpeakRequest): Promise<void>;
}
