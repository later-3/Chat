import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openChatSession } from "../../chat-session.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../session-operation-lock.js";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../../persistence/versioned-file.js";
import { isNanoClawTemporarilyUnavailable, sendNanoClawAgentMessage } from "../nanoclaw-client.js";
import { readLongAgentRegistry } from "../storage.js";
import type { LongAgentAddress } from "../types.js";
import { ConversationError, activeMember } from "./contract.js";
import { conversationDataDir } from "./discussions.js";
import { GROUP_EXTERNAL_MESSAGE, readConversationPublicMessages } from "./publication.js";
import { readConversation } from "./service.js";
import { listAllConversations } from "./storage.js";

/**
 * LA6 B: external channel binding for a group conversation.
 *
 * The binding is created only by an authorized owner entry (HTTP/Tool) for an active member; an
 * inbound external message can only route to an existing active binding and can never create an owner,
 * widen authorization or pick another source Session. Inbound dedup is by stable external event/message
 * identity, outbound delivery is by a stable publication-derived delivery id, and delivery retries never
 * regenerate the answer.
 */
export interface ConversationChannelDestination extends LongAgentAddress {
  readonly channelType: string;
  readonly messagingGroupId: string;
}

export interface ConversationChannelBinding {
  schemaVersion: 1;
  bindingId: string;
  conversationId: string;
  longAgentId: string;
  instanceId: string;
  agentGroupId: string;
  destination: ConversationChannelDestination;
  /** The Friend's bot identity on the platform, used to drop its own echoed messages. */
  botPlatformId: string | null;
  audience: "members";
  status: "active" | "unbound";
  /** Monotonic revision of the Chat-owned binding state; every bind/unbind bumps it. */
  syncRevision: number;
  /** Revision NanoClaw has confirmed; `null`/behind means the mirror is still pending. */
  syncedRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationChannelState {
  schemaVersion: 1;
  revision: number;
  bindings: ConversationChannelBinding[];
}

/**
 * `queued` = NanoClaw durably accepted the message for platform delivery. It is NOT platform
 * confirmation: only a Nano delivery receipt may move it to `delivered`.
 */
export type ConversationDeliveryStatus = "pending" | "queued" | "delivered" | "failed" | "unknown";

export interface ConversationDelivery {
  schemaVersion: 1;
  deliveryId: string;
  conversationId: string;
  bindingId: string;
  publicationId: string;
  /** Stable idempotency key sent to the platform. A retry reuses it; the model is never called again. */
  messageId: string;
  status: ConversationDeliveryStatus;
  nanoSessionId: string | null;
  /** Platform-side message id from the delivery receipt; null while unconfirmed. */
  platformMessageId: string | null;
  /** Claim token of the in-flight attempt; a stale result is discarded instead of overwriting state. */
  attemptToken: string | null;
  claimedAt: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationDeliveryState {
  schemaVersion: 1;
  deliveries: ConversationDelivery[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new ConversationError(500, `外部渠道${label}无效`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  return value === null || value === undefined ? null : text(value, label, max);
}

function parseDestination(value: unknown): ConversationChannelDestination {
  if (!record(value)) throw new ConversationError(500, "外部渠道目标无效");
  return {
    channelType: text(value.channelType, "channelType", 60),
    instance: text(value.instance, "instance", 60),
    platformId: text(value.platformId, "platformId", 200),
    threadId: optionalText(value.threadId, "threadId", 200),
    messagingGroupId: text(value.messagingGroupId, "messagingGroupId", 200),
  };
}

function parseBinding(value: unknown): ConversationChannelBinding {
  if (!record(value)) throw new ConversationError(500, "外部渠道绑定无效");
  const status = value.status === "unbound" ? "unbound" : "active";
  return {
    schemaVersion: 1,
    bindingId: text(value.bindingId, "bindingId", 200),
    conversationId: text(value.conversationId, "conversationId", 200),
    longAgentId: text(value.longAgentId, "longAgentId", 120),
    instanceId: text(value.instanceId, "instanceId", 60),
    agentGroupId: text(value.agentGroupId, "agentGroupId", 200),
    destination: parseDestination(value.destination),
    botPlatformId: optionalText(value.botPlatformId, "botPlatformId", 200),
    audience: "members",
    status,
    // A legacy binding without sync fields is treated as unsynced so the mirror is re-established.
    syncRevision: Number.isSafeInteger(value.syncRevision) && Number(value.syncRevision) >= 0 ? Number(value.syncRevision) : 1,
    syncedRevision: Number.isSafeInteger(value.syncedRevision) && Number(value.syncedRevision) >= 0 ? Number(value.syncedRevision) : null,
    createdAt: text(value.createdAt, "createdAt", 64),
    updatedAt: text(value.updatedAt, "updatedAt", 64),
  };
}

function parseDelivery(value: unknown): ConversationDelivery {
  if (!record(value)) throw new ConversationError(500, "外部投递记录无效");
  const statuses: ConversationDeliveryStatus[] = ["pending", "queued", "delivered", "failed", "unknown"];
  if (!statuses.includes(value.status as ConversationDeliveryStatus)) throw new ConversationError(500, "外部投递状态无效");
  return {
    schemaVersion: 1,
    deliveryId: text(value.deliveryId, "deliveryId", 200),
    conversationId: text(value.conversationId, "conversationId", 200),
    bindingId: text(value.bindingId, "bindingId", 200),
    publicationId: text(value.publicationId, "publicationId", 200),
    messageId: text(value.messageId, "messageId", 200),
    status: value.status as ConversationDeliveryStatus,
    nanoSessionId: optionalText(value.nanoSessionId, "nanoSessionId", 200),
    platformMessageId: optionalText(value.platformMessageId, "platformMessageId", 200),
    attemptToken: optionalText(value.attemptToken, "attemptToken", 200),
    claimedAt: optionalText(value.claimedAt, "claimedAt", 64),
    error: optionalText(value.error, "error", 2_000),
    attempts: Number(value.attempts),
    createdAt: text(value.createdAt, "createdAt", 64),
    updatedAt: text(value.updatedAt, "updatedAt", 64),
  };
}

export function channelBindingId(input: { conversationId: string; instanceId: string; destination: ConversationChannelDestination }): string {
  const { conversationId, instanceId, destination } = input;
  return `chb-${createHash("sha256").update(JSON.stringify([conversationId, instanceId, destination.channelType, destination.instance, destination.platformId, destination.threadId, destination.messagingGroupId])).digest("hex").slice(0, 32)}`;
}

export function deliveryIdOf(publicationId: string, bindingId: string): string {
  return `cdel-${createHash("sha256").update(JSON.stringify([publicationId, bindingId])).digest("hex").slice(0, 32)}`;
}

/**
 * Serializes every write/send decision for one delivery inside this Backend process. Without it, a
 * platform receipt racing an in-flight send could be overwritten and the message re-sent.
 */
const deliveryLocks = new Map<string, Promise<void>>();
async function withDeliveryLock<T>(deliveryId: string, operation: () => Promise<T>): Promise<T> {
  const previous = deliveryLocks.get(deliveryId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  deliveryLocks.set(deliveryId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (deliveryLocks.get(deliveryId) === tail) deliveryLocks.delete(deliveryId);
  }
}

/**
 * Single status-transition policy shared by every writer. `delivered` is a confirmed platform fact
 * and is never downgraded by a later (or racing) persistence/retry write; `unknown` also never
 * silently regresses to a value that would trigger an automatic resend.
 */
export function guardDeliveryTransition(current: ConversationDeliveryStatus, next: ConversationDeliveryStatus): ConversationDeliveryStatus {
  if (current === "delivered") return "delivered";
  if (current === "unknown" && (next === "pending" || next === "queued")) return "unknown";
  return next;
}

async function channelsFile(chatHome: string, storageProjectId: string, conversationId: string): Promise<string> {
  return resolve(await conversationDataDir(chatHome, storageProjectId, conversationId), "channels.json");
}

async function deliveriesFile(chatHome: string, storageProjectId: string, conversationId: string): Promise<string> {
  return resolve(await conversationDataDir(chatHome, storageProjectId, conversationId), "deliveries.json");
}

export async function readConversationChannelState(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationChannelState> {
  const file = await channelsFile(chatHome, storageProjectId, conversationId);
  await assertFileWithin(file, chatHome);
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.bindings))
      throw new ConversationError(500, "外部渠道存储格式无效");
    return { schemaVersion: 1, revision: Number(value.revision), bindings: value.bindings.map(parseBinding) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, revision: 0, bindings: [] };
    throw error;
  }
}

async function changeChannelState<T>(chatHome: string, storageProjectId: string, conversationId: string, change: (state: ConversationChannelState) => T): Promise<T> {
  const file = await channelsFile(chatHome, storageProjectId, conversationId);
  return withFileLock(file, async () => {
    const state = await readConversationChannelState(chatHome, storageProjectId, conversationId);
    const result = change(state);
    await atomicWriteJson(file, state);
    return result;
  });
}

async function readDeliveryState(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationDeliveryState> {
  const file = await deliveriesFile(chatHome, storageProjectId, conversationId);
  await assertFileWithin(file, chatHome);
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.deliveries)) throw new ConversationError(500, "外部投递存储格式无效");
    return { schemaVersion: 1, deliveries: value.deliveries.map(parseDelivery) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, deliveries: [] };
    throw error;
  }
}

async function changeDeliveryState<T>(chatHome: string, storageProjectId: string, conversationId: string, change: (state: ConversationDeliveryState) => T): Promise<T> {
  const file = await deliveriesFile(chatHome, storageProjectId, conversationId);
  return withFileLock(file, async () => {
    const state = await readDeliveryState(chatHome, storageProjectId, conversationId);
    const result = change(state);
    await atomicWriteJson(file, state);
    return result;
  });
}

export async function listConversationChannels(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationChannelBinding[]> {
  return (await readConversationChannelState(chatHome, storageProjectId, conversationId)).bindings;
}

/** Bindings whose NanoClaw mirror has not confirmed the current sync revision. */
export async function listPendingConversationChannelSyncs(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationChannelBinding[]> {
  return (await readConversationChannelState(chatHome, storageProjectId, conversationId)).bindings
    .filter((binding) => binding.syncedRevision !== binding.syncRevision);
}

/**
 * Record that NanoClaw confirmed `syncRevision`. CAS on the current revision so a late acknowledgement
 * for an older revision can never mark a newer bind/unbind as mirrored.
 */
export async function markConversationChannelSynced(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  bindingId: string;
  syncRevision: number;
  synced: boolean;
}): Promise<ConversationChannelBinding> {
  return changeChannelState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const binding = state.bindings.find((candidate) => candidate.bindingId === input.bindingId);
    if (binding === undefined) throw new ConversationError(404, "找不到外部渠道绑定");
    if (input.synced && binding.syncRevision === input.syncRevision) binding.syncedRevision = input.syncRevision;
    const now = new Date().toISOString();
    binding.updatedAt = now;
    state.bindings = [...state.bindings];
    return { ...binding };
  });
}

/**
 * Bind one external destination to a group. Only an authorized owner entry calls this; it validates
 * that the acting Friend is an active member and that the NanoClaw instance exists, and it records the
 * Friend's agent group id so later deliveries are stable. It never accepts an owner identity.
 */
export async function bindConversationChannel(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  instanceId: string;
  expectedRevision: number;
  destination: ConversationChannelDestination;
  botPlatformId?: string | null;
}): Promise<ConversationChannelBinding> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new ConversationError(400, "expectedRevision 无效");
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能绑定外部渠道");
  const member = activeMember(conversation, input.longAgentId);
  if (member === null) throw new ConversationError(409, "只有当前成员 Friend 可以绑定外部渠道");
  const registry = await readLongAgentRegistry(input.chatHome);
  const instance = registry.instances.find((candidate) => candidate.id === input.instanceId);
  if (instance === undefined) throw new ConversationError(404, `找不到 NanoClaw 实例：${input.instanceId}`);
  const agent = registry.agents.find((candidate) => candidate.id === input.longAgentId);
  if (agent === undefined) throw new ConversationError(404, `找不到 Friend：${input.longAgentId}`);
  const destination = parseDestination(input.destination);
  const bindingId = channelBindingId({ conversationId: input.conversationId, instanceId: input.instanceId, destination });
  return changeChannelState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    if (state.revision !== input.expectedRevision)
      throw new ConversationError(409, `外部渠道绑定已被修改（当前 revision ${String(state.revision)}），请刷新后重试`);
    const now = new Date().toISOString();
    const existing = state.bindings.find((binding) => binding.bindingId === bindingId);
    if (existing !== undefined) {
      existing.status = "active";
      existing.longAgentId = input.longAgentId;
      existing.agentGroupId = agent.nanoclawAgentGroupId;
      existing.botPlatformId = input.botPlatformId ?? null;
      existing.syncRevision += 1;
      existing.updatedAt = now;
      state.revision += 1;
      return { ...existing };
    }
    const binding: ConversationChannelBinding = {
      schemaVersion: 1, bindingId, conversationId: input.conversationId, longAgentId: input.longAgentId,
      instanceId: input.instanceId, agentGroupId: agent.nanoclawAgentGroupId, destination,
      botPlatformId: input.botPlatformId ?? null, audience: "members", status: "active",
      syncRevision: 1, syncedRevision: null,
      createdAt: now, updatedAt: now,
    };
    state.bindings.push(binding);
    state.revision += 1;
    return { ...binding };
  });
}

/** Unbind: history stays, but no inbound routes and no outbound is attempted for this destination. */
export async function unbindConversationChannel(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  bindingId: string;
  expectedRevision: number;
}): Promise<ConversationChannelBinding> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  // Serialize with inbound append so an unbind that lands first is not bypassed by a stale binding read.
  return withChatSessionOperationLock(chatSessionOperationKey(input.storageProjectId, conversation.publicSessionId), async () => changeChannelState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    if (state.revision !== input.expectedRevision)
      throw new ConversationError(409, `外部渠道绑定已被修改（当前 revision ${String(state.revision)}），请刷新后重试`);
    const binding = state.bindings.find((candidate) => candidate.bindingId === input.bindingId);
    if (binding === undefined) throw new ConversationError(404, "找不到外部渠道绑定");
    binding.status = "unbound";
    binding.syncRevision += 1;
    binding.updatedAt = new Date().toISOString();
    state.revision += 1;
    return { ...binding };
  }));
}

/**
 * Accept one inbound external message. The caller supplies identities from its trusted ingress; this
 * function only routes them to an existing active binding, drops the Friend's own echo, and appends the
 * message once per stable external id under the public-root lock.
 */
export async function acceptConversationInboundMessage(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  bindingId: string;
  senderExternalId: string;
  senderDisplayName: string | null;
  text: string;
  externalMessageId: string;
  eventId: string;
}): Promise<{ accepted: boolean; appended: boolean; entryId: string | null; reason: string | null }> {
  if (input.text.trim() === "" || input.text.length > 100_000) throw new ConversationError(400, "外部消息正文无效");
  if (input.senderExternalId.trim() === "") throw new ConversationError(400, "外部消息缺少发送者身份");
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (conversation.lifecycle === "archived")
    return { accepted: false, appended: false, entryId: null, reason: "群已归档，拒绝接收外部消息" };
  // The binding/lifecycle/unbind arbitration and the append share the public-root lock, so an unbind
  // that lands before the append is honoured rather than racing a stale binding read.
  return withChatSessionOperationLock(chatSessionOperationKey(input.storageProjectId, conversation.publicSessionId), async () => {
    const fresh = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
    if (fresh.lifecycle === "archived")
      return { accepted: false, appended: false, entryId: null, reason: "群已归档，拒绝接收外部消息" };
    const state = await readConversationChannelState(input.chatHome, input.storageProjectId, input.conversationId);
    const binding = state.bindings.find((candidate) => candidate.bindingId === input.bindingId);
    if (binding === undefined || binding.status !== "active")
      return { accepted: false, appended: false, entryId: null, reason: "外部目标未绑定或已解绑，拒绝接收" };
    if (binding.botPlatformId !== null && binding.botPlatformId === input.senderExternalId)
      return { accepted: false, appended: false, entryId: null, reason: "消息来自 Friend 自己的机器人身份，忽略以避免回环" };
    const reopened = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: fresh.publicSessionId });
    const entries = reopened.manager.getEntries();
    const existing = entries.find((entry) =>
      entry.type === "custom" && entry.customType === GROUP_EXTERNAL_MESSAGE && record(entry.data)
      && (entry.data.eventId === input.eventId
        || (entry.data.bindingId === input.bindingId && entry.data.externalMessageId === input.externalMessageId)));
    if (existing !== undefined) return { accepted: true, appended: false, entryId: existing.id, reason: null };
    const postedAt = new Date().toISOString();
    reopened.manager.appendCustomEntry(GROUP_EXTERNAL_MESSAGE, {
      conversationId: input.conversationId, bindingId: input.bindingId,
      senderExternalId: input.senderExternalId, senderDisplayName: input.senderDisplayName,
      externalMessageId: input.externalMessageId, eventId: input.eventId, text: input.text, postedAt,
    });
    reopened.manager.flush();
    const appended = reopened.manager.getEntries().at(-1);
    return { accepted: true, appended: true, entryId: appended?.id ?? null, reason: null };
  });
}

/** Locate one binding by its stable id across the registered storage Projects (trusted ingress routing). */
export async function findConversationChannelBinding(chatHome: string, bindingId: string): Promise<{ binding: ConversationChannelBinding; storageProjectId: string; conversationId: string } | null> {
  for (const { conversation, storageProjectId } of await listAllConversations(chatHome)) {
    const state = await readConversationChannelState(chatHome, storageProjectId, conversation.id).catch(() => null);
    const binding = state?.bindings.find((candidate) => candidate.bindingId === bindingId);
    if (binding !== undefined) return { binding, storageProjectId, conversationId: conversation.id };
  }
  return null;
}

/** Locate one delivery by its stable id across the registered storage Projects (trusted receipt routing). */
export async function findConversationDelivery(chatHome: string, deliveryId: string): Promise<{ delivery: ConversationDelivery; storageProjectId: string; conversationId: string } | null> {
  for (const { conversation, storageProjectId } of await listAllConversations(chatHome)) {
    const state = await readDeliveryState(chatHome, storageProjectId, conversation.id).catch(() => null);
    const delivery = state?.deliveries.find((candidate) => candidate.deliveryId === deliveryId);
    if (delivery !== undefined) return { delivery, storageProjectId, conversationId: conversation.id };
  }
  return null;
}

export async function readConversationDeliveries(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationDelivery[]> {
  return (await readDeliveryState(chatHome, storageProjectId, conversationId)).deliveries;
}

/**
 * Deliver one committed publication to every active binding of the group.
 *
 * The text is always re-resolved from the current authorized public projection by `publicationId`; a
 * caller cannot supply arbitrary content, and a nonexistent or unavailable reference is rejected
 * before any gateway call. An archived group delivers nothing.
 */
export async function deliverConversationPublication(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  publicationId: string;
}): Promise<ConversationDelivery[]> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，拒绝投递");
  const published = (await readConversationPublicMessages({
    chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
    viewerLongAgentId: null,
  })).find((message) => message.publicationId === input.publicationId);
  if (published === undefined || published.text === null)
    throw new ConversationError(409, "公开引用不存在或不可用，拒绝投递");
  const text = published.text;
  const state = await readConversationChannelState(input.chatHome, input.storageProjectId, input.conversationId);
  const active = state.bindings.filter((binding) => binding.status === "active");
  const results: ConversationDelivery[] = [];
  for (const binding of active) {
    results.push(await deliverToBinding({ ...input, text }, binding));
  }
  return results;
}

async function deliverToBinding(
  input: { chatHome: string; storageProjectId: string; conversationId: string; publicationId: string; text: string },
  binding: ConversationChannelBinding,
): Promise<ConversationDelivery> {
  const deliveryId = deliveryIdOf(input.publicationId, binding.bindingId);
  // Short critical section: admission + attempt claim only. The remote HTTP call happens outside the
  // lock so a platform receipt can complete while the send is in flight (no lock cycle with the gateway).
  const claim = await withDeliveryLock(deliveryId, async (): Promise<
    | { kind: "settled"; delivery: ConversationDelivery }
    | { kind: "no-instance"; attempts: number }
    | { kind: "send"; delivery: ConversationDelivery; instance: Parameters<typeof sendNanoClawAgentMessage>[0]["instance"] }
  > => {
    const existing = (await readDeliveryState(input.chatHome, input.storageProjectId, input.conversationId)).deliveries.find((d) => d.deliveryId === deliveryId);
    // A pending/queued/delivered/uncertain delivery is never sent again: a retry would duplicate or fake
    // exactly-once. Only a definitive failure (or a first attempt) may proceed.
    if (existing !== undefined && existing.status !== "failed") return { kind: "settled", delivery: existing };
    const registry = await readLongAgentRegistry(input.chatHome);
    const instance = registry.instances.find((candidate) => candidate.id === binding.instanceId);
    if (instance === undefined) return { kind: "no-instance", attempts: existing?.attempts ?? 0 };
    const attempted = await claimDeliveryAttempt(input, deliveryId, binding, input.publicationId);
    if (attempted === null) {
      const current = (await readDeliveryState(input.chatHome, input.storageProjectId, input.conversationId)).deliveries.find((d) => d.deliveryId === deliveryId);
      if (current === undefined) throw new ConversationError(500, "外部投递状态丢失");
      return { kind: "settled", delivery: current };
    }
    return { kind: "send", delivery: attempted, instance };
  });
  if (claim.kind === "settled") return claim.delivery;
  if (claim.kind === "no-instance") {
    return recordDeliveryResult(input, deliveryId, binding, "failed", null, "NanoClaw 实例不存在，无法投递", claim.attempts);
  }
  try {
    const sent = await sendNanoClawAgentMessage({
      instance: claim.instance, agentGroupId: binding.agentGroupId, destination: binding.destination,
      messageId: claim.delivery.messageId, text: input.text,
    });
    // HTTP 200 only means NanoClaw durably queued the message; the platform receipt is a separate fact.
    return await recordDeliveryResult(input, deliveryId, binding, "queued", sent.nanoSessionId, null, claim.delivery.attempts, claim.delivery.attemptToken);
  } catch (error) {
    // A transport timeout or an unavailable gateway means the platform result is unknown: keep the
    // association, surface "待核查", and never auto-resend the same content as if it were delivered.
    const unknown = isNanoClawTemporarilyUnavailable(error);
    const message = error instanceof Error ? error.message : String(error);
    return await recordDeliveryResult(input, deliveryId, binding, unknown ? "unknown" : "failed", null, message, claim.delivery.attempts, claim.delivery.attemptToken);
  }
}

async function recordDeliveryResult(
  input: { chatHome: string; storageProjectId: string; conversationId: string },
  deliveryId: string,
  binding: ConversationChannelBinding,
  status: ConversationDeliveryStatus,
  nanoSessionId: string | null,
  error: string | null,
  attempts: number,
  attemptToken: string | null = null,
): Promise<ConversationDelivery> {
  return changeDeliveryState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const now = new Date().toISOString();
    let delivery = state.deliveries.find((d) => d.deliveryId === deliveryId);
    // A result from a superseded attempt (restart, recovery or a newer claim) must not overwrite the
    // current state; the receipt path has its own guarded transition.
    // CAS: only the attempt that still owns the claim may publish its result. A superseded attempt
    // (restart, recovery to null, or a newer claim) is discarded instead of overwriting the state.
    if (delivery !== undefined && delivery.attemptToken !== attemptToken) {
      return { ...delivery };
    }
    if (delivery === undefined) {
      delivery = {
        schemaVersion: 1, deliveryId, conversationId: input.conversationId, bindingId: binding.bindingId,
        publicationId: "", messageId: deliveryId, status, nanoSessionId, platformMessageId: null,
        attemptToken, claimedAt: now, error, attempts, createdAt: now, updatedAt: now,
      };
      state.deliveries.push(delivery);
    }
    delivery.status = guardDeliveryTransition(delivery.status, status);
    delivery.nanoSessionId = nanoSessionId;
    delivery.error = error;
    delivery.attempts = attempts;
    delivery.attemptToken = null;
    delivery.claimedAt = null;
    delivery.updatedAt = now;
    return { ...delivery };
  });
}

/** Set pending only when the guarded transition allows it; returns the claimed delivery or null. */
async function claimDeliveryAttempt(
  input: { chatHome: string; storageProjectId: string; conversationId: string },
  deliveryId: string,
  binding: ConversationChannelBinding,
  publicationId: string,
): Promise<ConversationDelivery | null> {
  return changeDeliveryState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const now = new Date().toISOString();
    let delivery = state.deliveries.find((d) => d.deliveryId === deliveryId);
    // An already-claimed pending is an in-flight attempt: a concurrent re-entry must not claim it again.
    if (delivery !== undefined && delivery.status !== "failed") return null;
    if (delivery === undefined) {
      delivery = {
        schemaVersion: 1, deliveryId, conversationId: input.conversationId, bindingId: binding.bindingId,
        publicationId, messageId: deliveryId, status: "pending", nanoSessionId: null, platformMessageId: null,
        attemptToken: null, claimedAt: null, error: null, attempts: 0, createdAt: now, updatedAt: now,
      };
      state.deliveries.push(delivery);
    }
    delivery.status = "pending";
    delivery.attemptToken = randomUUID();
    delivery.claimedAt = now;
    delivery.attempts += 1;
    delivery.updatedAt = now;
    return { ...delivery };
  });
}

/**
 * Trusted NanoClaw delivery receipt: only this can mark `delivered`/`failed`. A receipt for an
 * already delivered message is ignored so a late "failed" cannot overwrite a confirmed delivery.
 */
export async function confirmConversationDelivery(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  deliveryId: string;
  status: "delivered" | "failed";
  platformMessageId?: string | null;
  error?: string | null;
}): Promise<ConversationDelivery> {
  // The receipt shares the delivery lock, so it cannot race an in-flight send's result write.
  return withDeliveryLock(input.deliveryId, async () => changeDeliveryState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const delivery = state.deliveries.find((candidate) => candidate.deliveryId === input.deliveryId);
    if (delivery === undefined) throw new ConversationError(404, "找不到外部投递记录");
    delivery.status = guardDeliveryTransition(delivery.status, input.status);
    if (delivery.status === input.status && input.platformMessageId !== undefined) delivery.platformMessageId = input.platformMessageId;
    delivery.error = input.status === "delivered" ? null : (input.error ?? delivery.error);
    if (delivery.status === "delivered" || delivery.status === "failed") {
      delivery.attemptToken = null;
      delivery.claimedAt = null;
    }
    delivery.updatedAt = new Date().toISOString();
    return { ...delivery };
  }));
}

/**
 * Retry definitive failures only. `unknown` deliveries need an explicit human/platform check; the
 * stable `messageId` means a retry cannot create a second platform message, and the model is never
 * involved here.
 */
export const STALE_DELIVERY_CLAIM_MS = 2 * 60 * 1000;

/**
 * Restart recovery: a `pending` delivery whose claim is older than the threshold lost its worker (crash
 * or restart). Its platform result is unknown, so it becomes `unknown` for review and is never resent.
 */
export async function recoverConversationDeliveries(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  now?: number;
  staleClaimMs?: number;
}): Promise<ConversationDelivery[]> {
  const now = input.now ?? Date.now();
  const staleMs = input.staleClaimMs ?? STALE_DELIVERY_CLAIM_MS;
  return changeDeliveryState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const recovered: ConversationDelivery[] = [];
    for (const delivery of state.deliveries) {
      if (delivery.status !== "pending" || delivery.claimedAt === null) continue;
      if (now - Date.parse(delivery.claimedAt) < staleMs) continue;
      delivery.status = "unknown";
      delivery.error = "投递过程中进程重启或超时，结果待核查，不自动重发";
      delivery.attemptToken = null;
      delivery.updatedAt = new Date(now).toISOString();
      recovered.push({ ...delivery });
    }
    return recovered;
  });
}

export async function drainConversationDeliveries(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
}): Promise<ConversationDelivery[]> {
  await recoverConversationDeliveries(input);
  const state = await readConversationChannelState(input.chatHome, input.storageProjectId, input.conversationId);
  // `queued` awaits a Nano/platform receipt and `unknown` needs review; neither is auto-resent.
  const pendingOrFailed = (await readDeliveryState(input.chatHome, input.storageProjectId, input.conversationId)).deliveries
    .filter((delivery) => delivery.status === "pending" || delivery.status === "failed");
  const results: ConversationDelivery[] = [];
  for (const delivery of pendingOrFailed) {
    const binding = state.bindings.find((candidate) => candidate.bindingId === delivery.bindingId);
    if (binding === undefined || binding.status !== "active") {
      results.push(await changeDeliveryState(input.chatHome, input.storageProjectId, input.conversationId, (current) => {
        const target = current.deliveries.find((candidate) => candidate.deliveryId === delivery.deliveryId)!;
        target.status = "failed";
        target.error = "外部渠道已解绑，停止投递";
        target.updatedAt = new Date().toISOString();
        return { ...target };
      }));
      continue;
    }
    // Recover the public text from the authorized projection; private content is never delivered.
    const viewer = binding.longAgentId;
    const published = (await readConversationPublicMessages({
      chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
      viewerLongAgentId: viewer,
    })).find((message) => message.publicationId === delivery.publicationId);
    if (published === undefined || published.text === null) {
      results.push(await recordDeliveryResult(input, delivery.deliveryId, binding, "failed", null, "公开引用不可用，停止投递", delivery.attempts));
      continue;
    }
    results.push(await deliverToBinding({ ...input, publicationId: delivery.publicationId, text: published.text }, binding));
  }
  return results;
}
