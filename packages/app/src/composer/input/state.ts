import type { SendShortcut } from "@/hooks/use-settings";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { MessagePayload, TextReplacement } from "@/composer/types";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import type { ComposerKeyPressEvent } from "./input";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

export type SendBehavior = ActiveTurnBehavior | "queue";

export function resolveActiveSendBehavior(
  sendBehavior: SendBehavior,
  hasPendingPermission: boolean,
): SendBehavior {
  return sendBehavior === "queue" && hasPendingPermission ? "interrupt" : sendBehavior;
}

interface ComposerSurfaceState {
  opacity: 0 | 1;
  pointerEvents: "auto" | "none";
}

export interface ComposerSurfacePresentation {
  input: ComposerSurfaceState;
  overlay: ComposerSurfaceState;
}

const INPUT_PRESENTATION: ComposerSurfacePresentation = {
  input: { opacity: 1, pointerEvents: "auto" },
  overlay: { opacity: 0, pointerEvents: "none" },
};

const OVERLAY_PRESENTATION: ComposerSurfacePresentation = {
  input: { opacity: 0, pointerEvents: "none" },
  overlay: { opacity: 1, pointerEvents: "auto" },
};

export function resolveComposerSurfacePresentation(
  showOverlay: boolean,
): ComposerSurfacePresentation {
  return showOverlay ? OVERLAY_PRESENTATION : INPUT_PRESENTATION;
}

interface StopRealtimeVoiceContext {
  voice: { stopVoice: () => Promise<unknown> } | null | undefined;
  isRealtimeVoiceForCurrentAgent: boolean;
  isAgentRunning: boolean;
  client: { cancelAgent: (agentId: string) => Promise<unknown> } | null;
  voiceAgentId: string | undefined;
}

interface SendActionContext {
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  handleSendMessage: () => void;
  handleQueueMessage: () => void;
}

interface DictationTranscriptContext {
  value: string;
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmit: (payload: MessagePayload) => void;
  replaceText: (text: string) => void;
  attachments: MessagePayload["attachments"];
  cwd: string;
  autoSend: boolean;
}

export function applyDictationTranscript(text: string, ctx: DictationTranscriptContext): void {
  if (!text) return;
  const shouldPad = ctx.value.length > 0 && !/\s$/.test(ctx.value);
  const nextValue = `${ctx.value}${shouldPad ? " " : ""}${text}`;

  if (!ctx.autoSend) {
    ctx.replaceText(nextValue);
    return;
  }

  ctx.replaceText(nextValue);

  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.onQueue({ text: nextValue, attachments: ctx.attachments, cwd: ctx.cwd });
    ctx.replaceText("");
    return;
  }

  ctx.onSubmit({
    text: nextValue,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
}

interface MessageInputKeyboardActions {
  focusInput: () => void;
  isDictationRecording: () => boolean;
  markTranscriptForSend: () => void;
  confirmDictation: () => void | Promise<void>;
  cancelDictation: () => void | Promise<void>;
  startDictation: () => void | Promise<void>;
  toggleRealtimeVoice: () => void;
  isRealtimeVoiceActive: boolean;
  toggleRealtimeVoiceMute: () => void;
}

export function computeCanStartDictation(input: {
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  disabled: boolean;
  dictationUnavailableMessage: string | null | undefined;
}): boolean {
  const socketConnected = input.client?.isConnected ?? false;
  const readyForDictation = input.isReadyForDictation ?? socketConnected;
  return (
    socketConnected && readyForDictation && !input.disabled && !input.dictationUnavailableMessage
  );
}

export function runDefaultSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
    return;
  }
  ctx.handleSendMessage();
}

export type AlternateSendAction = "queue" | "send";

/**
 * What Mod+Enter and a long-press on Send do instead of the default send. Null while
 * no turn is running, where both fall back to the default send.
 */
export function resolveAlternateSendAction(
  ctx: Pick<SendActionContext, "defaultSendBehavior" | "isAgentRunning" | "onQueue">,
): AlternateSendAction | null {
  if (!ctx.isAgentRunning || !ctx.onQueue) return null;
  return ctx.defaultSendBehavior === "queue" ? "send" : "queue";
}

export function runAlternateSendAction(ctx: SendActionContext): void {
  const action = resolveAlternateSendAction(ctx);
  if (action === "queue") {
    ctx.handleQueueMessage();
    return;
  }
  if (action === "send") {
    ctx.handleSendMessage();
    return;
  }
  runDefaultSendAction(ctx);
}

export type MessageInputEnterAction = "alternate-send" | "default-send";

export interface MessageInputEnterContext {
  submitOnEnter: boolean;
  sendShortcut: SendShortcut;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
}

export function resolveMessageInputEnterAction(
  ctx: MessageInputEnterContext,
): MessageInputEnterAction | null {
  if (!ctx.submitOnEnter) return null;
  if (ctx.shiftKey) return null;
  const hasModifier = ctx.metaKey || ctx.ctrlKey;
  if (ctx.sendShortcut === "mod-enter") return hasModifier ? "default-send" : null;
  if (hasModifier && ctx.isAgentRunning && ctx.onQueue) return "alternate-send";
  return "default-send";
}

export interface DesktopEnterKeyEvent {
  nativeEvent: {
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  };
  preventDefault(): void;
}

export interface DesktopKeyPressContext {
  onKeyPressCallback: ((event: ComposerKeyPressEvent) => boolean) | undefined;
  input: ComposerKeyPressEvent["input"];
  submitOnEnter: boolean;
  sendShortcut: SendShortcut;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  isSendInFlight: boolean;
  disabled: boolean;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
  handleQueueMessage: () => void;
}

function canQueueWhileSendInFlight(ctx: DesktopKeyPressContext): boolean {
  return ctx.isSendInFlight && !ctx.isSubmitDisabled && !ctx.disabled && ctx.onQueue !== undefined;
}

export function handleDesktopKeyPressImpl(
  event: DesktopEnterKeyEvent,
  ctx: DesktopKeyPressContext,
): void {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return;

  const { shiftKey, metaKey, ctrlKey, altKey } = event.nativeEvent;

  if (ctx.onKeyPressCallback) {
    const handled = ctx.onKeyPressCallback({
      key: event.nativeEvent.key,
      hasModifier: Boolean(shiftKey || metaKey || ctrlKey || altKey),
      preventDefault: () => event.preventDefault(),
      input: ctx.input,
    });
    if (handled) return;
  }

  if (event.nativeEvent.key !== "Enter") return;

  const action = resolveMessageInputEnterAction({
    submitOnEnter: ctx.submitOnEnter,
    sendShortcut: ctx.sendShortcut,
    shiftKey: shiftKey ?? false,
    metaKey: metaKey ?? false,
    ctrlKey: ctrlKey ?? false,
    isAgentRunning: ctx.isAgentRunning,
    onQueue: ctx.onQueue,
  });
  if (action === null) return;

  if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) {
    // The send button is in its loading state only because the previous send has not been
    // acknowledged yet; queue the next message behind it instead of swallowing Enter.
    if (canQueueWhileSendInFlight(ctx)) {
      event.preventDefault();
      ctx.handleQueueMessage();
    }
    return;
  }
  event.preventDefault();
  if (action === "alternate-send") {
    ctx.handleAlternateSendAction();
    return;
  }
  ctx.handleDefaultSendAction();
}

export function runMessageInputKeyboardAction(
  action: MessageInputKeyboardActionKind,
  actions: MessageInputKeyboardActions,
): boolean {
  if (action === "focus") {
    actions.focusInput();
    return true;
  }
  if (action === "send" || action === "dictation-confirm") {
    if (actions.isDictationRecording()) {
      actions.markTranscriptForSend();
      void actions.confirmDictation();
      return true;
    }
    return false;
  }
  if (action === "voice-toggle") {
    actions.toggleRealtimeVoice();
    return true;
  }
  if (action === "voice-mute-toggle") {
    if (actions.isRealtimeVoiceActive) {
      actions.toggleRealtimeVoiceMute();
    }
    return true;
  }
  if (action === "dictation-cancel") {
    if (actions.isDictationRecording()) {
      void actions.cancelDictation();
      return true;
    }
    return false;
  }
  if (action === "dictation-toggle") {
    if (actions.isDictationRecording()) {
      actions.markTranscriptForSend();
      void actions.confirmDictation();
    } else {
      void actions.startDictation();
    }
    return true;
  }
  return false;
}

export async function stopRealtimeVoice(ctx: StopRealtimeVoiceContext): Promise<void> {
  if (!ctx.voice || !ctx.isRealtimeVoiceForCurrentAgent) return;

  if (ctx.isAgentRunning) {
    if (!ctx.client || !ctx.voiceAgentId) {
      throw new Error("Cannot stop the running voice agent while the host is unavailable");
    }
    await ctx.client.cancelAgent(ctx.voiceAgentId);
  }

  await ctx.voice.stopVoice();
}

/**
 * Put the fullscreen glyph's visible right edge on the text rail, letting its
 * hit area extend into the padding. Both Lucide glyphs reach x21 of 24 and use
 * the default 2-unit stroke (one viewBox unit beyond the path).
 */
export function resolveGlyphRailOffset(input: {
  controlSize: number;
  glyphIconSize: number;
}): number {
  const inkInset = (input.controlSize - input.glyphIconSize) / 2 + (2 * input.glyphIconSize) / 24;
  return -inkInset;
}

export function resolveComposerSurfaceText(
  liveText: string,
  replacement: TextReplacement,
  appliedReplacementKey: string,
): string {
  return replacement.key === appliedReplacementKey ? liveText : replacement.text;
}

/** A retained caret must fit the text the remounted editor shows. */
export function resolveRetainedSelection(
  retained: { start: number; end: number },
  textLength: number,
): { start: number; end: number } {
  const end = Math.min(Math.max(retained.end, 0), textLength);
  const start = Math.min(Math.max(retained.start, 0), end);
  return { start, end };
}
