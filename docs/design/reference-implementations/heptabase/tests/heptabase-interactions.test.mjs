import test from "node:test";
import assert from "node:assert/strict";
import {
  askWithContext,
  createInitialState,
  getCard,
  goBack,
  openLocation,
  placeCard,
  placementsForCard,
  removePlacement,
  saveResponseAsCard,
  setPermission,
  updateCard,
  visibleCardIdsFor,
} from "../src/heptabaseModel.js";

test("one Card identity can have multiple Whiteboard placements", () => {
  const state = createInitialState();
  const locations = placementsForCard(state, "card-context-package");
  assert.equal(locations.length, 2);
  assert.equal(new Set(locations.map((item) => item.cardId)).size, 1);
});

test("editing canonical Card content updates every placement without copying", () => {
  const state = updateCard(createInitialState(), "card-context-package", { content: "revision 5" });
  assert.equal(getCard(state, "card-context-package").content, "revision 5");
  assert.equal(placementsForCard(state, "card-context-package").length, 2);
  assert.equal(state.cards.filter((card) => card.id === "card-context-package").length, 1);
});

test("placing an existing Card adds only a placement and is idempotent per board", () => {
  const initial = createInitialState();
  const first = placeCard(initial, "board-personal-studio", "card-context-package");
  const second = placeCard(first.state, "board-personal-studio", "card-context-package");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.state.cards.length, initial.cards.length);
  assert.equal(placementsForCard(second.state, "card-context-package").length, 3);
});

test("removing a placement never deletes the Card", () => {
  const initial = createInitialState();
  const next = removePlacement(initial, "board-project-research", "placement-context-research");
  assert.equal(next.cards.some((card) => card.id === "card-context-package"), true);
  assert.equal(placementsForCard(next, "card-context-package").length, 1);
});

test("location navigation and back restore the previous work context", () => {
  const initial = createInitialState();
  const focused = openLocation(initial, "board-ps2-planning", "placement-context-planning");
  assert.equal(focused.selectedBoardId, "board-ps2-planning");
  assert.equal(focused.focusedPlacementId, "placement-context-planning");
  const restored = goBack(focused);
  assert.equal(restored.selectedBoardId, initial.selectedBoardId);
  assert.equal(restored.selectedCardId, initial.selectedCardId);
});

test("AI access log distinguishes explicit context from optional Space search", () => {
  const initial = createInitialState();
  const explicit = askWithContext(initial, "What can be reused?");
  assert.equal(explicit.chat.audit.some((item) => item.startsWith("searched")), false);
  assert.equal(explicit.chat.audit.filter((item) => item.startsWith("viewed")).length, 2);
  const searched = askWithContext({ ...initial, chat: { ...initial.chat, spaceSearch: true } }, "What can be reused?");
  assert.equal(searched.chat.audit[0], "searched current Space");
});

test("saving an AI response creates a provenance Card but no automatic placement", () => {
  const answered = askWithContext(createInitialState(), "What can be reused?");
  const saved = saveResponseAsCard(answered);
  const created = getCard(saved, saved.selectedCardId);
  assert.equal(created.type, "candidate");
  assert.match(created.content, /生成来源/);
  assert.equal(placementsForCard(saved, created.id).length, 0);
});

test("collaborators only see Cards placed on explicitly shared Whiteboards", () => {
  const initial = createInitialState();
  const visible = visibleCardIdsFor(initial, "aju");
  assert.deepEqual(new Set(visible), new Set(["card-context-package", "card-memory-evidence", "card-shape-up", "card-agent-boundary"]));
  assert.equal(visible.includes("card-personal-studio"), false);
  const revoked = setPermission(initial, "board-project-research", "aju", "none");
  assert.equal(revoked.permissionsByBoardId["board-project-research"].aju, "none");
  assert.deepEqual(visibleCardIdsFor(revoked, "aju"), []);
});

test("each shared Whiteboard keeps an independent collaborator permission", () => {
  const initial = createInitialState();
  assert.equal(initial.permissionsByBoardId["board-project-research"].aju, "view");
  assert.equal(initial.permissionsByBoardId["board-ps2-planning"].aju, "none");

  const revokedFirst = setPermission(initial, "board-project-research", "aju", "none");
  const grantedSecond = setPermission(revokedFirst, "board-ps2-planning", "aju", "view");
  assert.equal(grantedSecond.permissionsByBoardId["board-project-research"].aju, "none");
  assert.equal(grantedSecond.permissionsByBoardId["board-ps2-planning"].aju, "view");
  assert.deepEqual(
    new Set(visibleCardIdsFor(grantedSecond, "aju")),
    new Set(["card-context-package", "card-shape-up", "card-iteration-gate"]),
  );
});
