import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CardsThree,
  ChatCircleText,
  Check,
  ClockCounterClockwise,
  Command,
  DotsThree,
  FileText,
  FolderOpen,
  Info,
  ListMagnifyingGlass,
  MagnifyingGlass,
  MapTrifold,
  NotePencil,
  Plus,
  ShareNetwork,
  SidebarSimple,
  SquaresFour,
  Tag,
  Trash,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import {
  askWithContext,
  createInitialState,
  getBoard,
  getCard,
  goBack,
  movePlacement,
  openLocation,
  people,
  placeCard,
  placementsForCard,
  removePlacement,
  saveResponseAsCard,
  setPermission,
  updateCard,
  visibleCardIdsFor,
} from "./heptabaseModel.js";

const appItems = [
  ["inbox", "Inbox", FolderOpen],
  ["journal", "Journal", NotePencil],
  ["whiteboards", "Whiteboards", MapTrifold],
  ["library", "Card Library", CardsThree],
  ["tags", "Tag Database", Tag],
  ["chat", "Chat", ChatCircleText],
];

function IconButton({ label, children, className = "", ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function LeftSidebar({ state, onSelectBoard, onOpenPanel }) {
  return (
    <aside className="left-sidebar" aria-label="Heptabase navigation">
      <div className="space-switcher">
        <span className="brand-mark">H</span>
        <span><strong>Later’s Space</strong><small>Private by default</small></span>
        <DotsThree size={20} weight="bold" />
      </div>
      <button className="research-button" onClick={() => onOpenPanel("chat")}>
        <ListMagnifyingGlass size={20} />
        <span><strong>Research a topic</strong><small>Sources → Whiteboard → Chat</small></span>
      </button>
      <nav className="app-list" aria-label="Apps">
        {appItems.map(([id, label, AppIcon]) => {
          const enabled = ["whiteboards", "library", "chat"].includes(id);
          return (
            <button
              key={id}
              className={id === "whiteboards" ? "active" : ""}
              onClick={() => (id === "library" || id === "chat" ? onOpenPanel(id) : undefined)}
              disabled={!enabled}
              title={enabled ? label : `${label} 不在本原型路径内`}
            >
              <AppIcon size={18} />{label}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-rule" />
      <div className="tab-heading"><span>Tabs</span><IconButton label="New tab is outside this reference path" disabled><Plus size={17} /></IconButton></div>
      {['Work', 'Life'].map((group) => (
        <section className="tab-group" key={group}>
          <p>{group}</p>
          {state.boards.filter((board) => board.group === group).map((board) => (
            <button key={board.id} className={state.selectedBoardId === board.id ? "selected" : ""} onClick={() => onSelectBoard(board.id)}>
              <MapTrifold size={17} /><span>{board.title}</span>{board.shared ? <ShareNetwork size={15} aria-label="Shared" /> : null}
            </button>
          ))}
        </section>
      ))}
      <div className="sidebar-footer"><UserCircle size={22} /><span>Later</span><span className="sync-state"><Check size={13} /> Synced</span></div>
    </aside>
  );
}

function WorkspaceHeader({ state, board, onBack, onOpenPanel, onShare, onToggleNav }) {
  return (
    <header className="workspace-header">
      <div className="breadcrumbs">
        <IconButton label="Open navigation" className="mobile-only" onClick={onToggleNav}><SidebarSimple size={20} /></IconButton>
        {state.history.length ? <IconButton label="Back to previous context" onClick={onBack}><ArrowLeft size={19} /></IconButton> : null}
        <MapTrifold size={18} /><span>Whiteboards</span><span className="crumb-separator">/</span><strong>{board.title}</strong>
      </div>
      <div className="workspace-actions">
        <button className="share-button" onClick={onShare}><ShareNetwork size={17} /> Share</button>
        <IconButton label="Card Library" onClick={() => onOpenPanel("library")}><CardsThree size={19} /></IconButton>
        <IconButton label="Chat" onClick={() => onOpenPanel("chat")}><ChatCircleText size={19} /></IconButton>
        <IconButton label="Board info" onClick={() => onOpenPanel("board")}><Info size={19} /></IconButton>
        <IconButton label="More board actions" onClick={() => onOpenPanel("board")}><DotsThree size={20} weight="bold" /></IconButton>
      </div>
    </header>
  );
}

function Connection({ connection, placements }) {
  const from = placements.find((item) => item.id === connection.from);
  const to = placements.find((item) => item.id === connection.to);
  if (!from || !to) return null;
  const x1 = from.x + from.width / 2;
  const y1 = from.y + 88;
  const x2 = to.x + to.width / 2;
  const y2 = to.y + 88;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);
  return <div className="connection" style={{ left: x1, top: y1, width: length, transform: `rotate(${angle}deg)` }} aria-hidden="true"><span>{connection.label}</span></div>;
}

function PlacementCard({ card, placement, selected, focused, onOpen, onMove, onRemove }) {
  return (
    <article
      className={`placement-card tone-${card.tone} ${selected ? "selected" : ""} ${focused ? "focused" : ""}`}
      style={{ left: placement.x, top: placement.y, width: placement.width }}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/plain", placement.id)}
      data-placement-id={placement.id}
    >
      <button className="placement-card-main" type="button" onClick={() => onOpen(card.id)} aria-label={`Open Card ${card.title}`}>
        <header><span className="card-type"><FileText size={15} /> {card.type}</span><DotsThree size={18} /></header>
        <h3>{card.title}</h3><p>{card.summary}</p>
      </button>
      <footer>
        <span>{card.tags[0]}</span>
        <div className="placement-actions">
          <button type="button" onClick={() => onMove(placement.id)}>Move</button>
          <button type="button" onClick={() => onRemove(placement.id)} aria-label={`Remove ${card.title} placement`}><Trash size={15} /></button>
        </div>
      </footer>
    </article>
  );
}

function Canvas({ state, setState, onOpenCard, onOpenPanel }) {
  const board = getBoard(state);
  const cardsById = useMemo(() => Object.fromEntries(state.cards.map((card) => [card.id, card])), [state.cards]);
  const dropRef = useRef(null);
  const handleDrop = (event) => {
    event.preventDefault();
    const placementId = event.dataTransfer.getData("text/plain");
    const rect = dropRef.current.getBoundingClientRect();
    setState((current) => movePlacement(current, board.id, placementId, {
      x: Math.max(24, event.clientX - rect.left - 100),
      y: Math.max(72, event.clientY - rect.top - 40),
    }));
  };
  return (
    <div className="canvas-shell">
      <div className="canvas-stage" ref={dropRef} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} aria-label={`${board.title} canvas`}>
        {board.sections.map((section) => (
          <section className={`board-section tone-${section.tone}`} style={{ left: section.x, top: section.y, width: section.width, height: section.height }} key={section.id}>
            <h2>{section.title}<DotsThree size={18} /></h2>
          </section>
        ))}
        {board.connections.map((connection) => <Connection key={connection.id} connection={connection} placements={board.placements} />)}
        {board.placements.map((placement) => (
          <PlacementCard
            key={placement.id}
            card={cardsById[placement.cardId]}
            placement={placement}
            selected={state.selectedCardId === placement.cardId}
            focused={state.focusedPlacementId === placement.id}
            onOpen={onOpenCard}
            onMove={(placementId) => setState((current) => movePlacement(current, board.id, placementId, { x: 116, y: 544 }))}
            onRemove={(placementId) => setState((current) => removePlacement(current, board.id, placementId))}
          />
        ))}
      </div>
      <div className="mobile-outline" aria-label={`${board.title} mobile outline`}>
        <p className="outline-note">空间关系已按 Section 改写为阅读顺序；Card identity 与桌面一致。</p>
        {board.sections.map((section) => {
          const placements = board.placements.filter((placement) => (
            placement.x >= section.x && placement.x <= section.x + section.width
            && placement.y >= section.y && placement.y <= section.y + section.height
          ));
          return (
            <section className={`outline-section tone-${section.tone}`} key={section.id}>
              <header><span className="outline-tone" /><h2>{section.title}</h2><span>{placements.length}</span></header>
              <div className="outline-cards">
                {placements.map((placement) => (
                  <PlacementCard
                    key={`mobile-${placement.id}`}
                    card={cardsById[placement.cardId]}
                    placement={placement}
                    selected={state.selectedCardId === placement.cardId}
                    focused={state.focusedPlacementId === placement.id}
                    onOpen={onOpenCard}
                    onMove={(placementId) => setState((current) => movePlacement(current, board.id, placementId, { x: section.x + 48, y: section.y + 96 }))}
                    onRemove={(placementId) => setState((current) => removePlacement(current, board.id, placementId))}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <div className="canvas-tools" aria-label="Canvas tools">
        <IconButton label="New card" onClick={() => onOpenPanel("library")}><FileText size={18} /></IconButton>
        <IconButton label="New section is outside this reference path" disabled><SquaresFour size={18} /></IconButton>
        <IconButton label="Command palette is outside this reference path" disabled><Command size={18} /></IconButton>
      </div>
      <div className="zoom-control"><button aria-label="Zoom out is outside this reference path" disabled>−</button><span>76%</span><button aria-label="Zoom in is outside this reference path" disabled>+</button></div>
    </div>
  );
}

function PanelTabs({ panel, onChange }) {
  const items = [["card", "Card", FileText], ["locations", "Locations", MapTrifold], ["library", "Library", CardsThree], ["chat", "Chat", ChatCircleText]];
  return (
    <div className="panel-tabs" role="tablist" aria-label="Right sidebar tools">
      {items.map(([id, label, PanelIcon]) => <button key={id} role="tab" aria-label={label} aria-selected={panel === id} onClick={() => onChange(id)}><PanelIcon size={18} /><span>{label}</span></button>)}
    </div>
  );
}

function CardPanel({ state, setState, onOpenPanel, onFocusLocation }) {
  const card = getCard(state);
  const locations = placementsForCard(state, card.id);
  return (
    <div className="panel-content card-panel">
      <div className="panel-kicker"><FileText size={16} /> Shared Card Library identity</div>
      <input className="card-title-input" aria-label="Card title" value={card.title} onChange={(event) => setState((current) => updateCard(current, card.id, { title: event.target.value }))} />
      <div className="tag-row">{card.tags.map((tag) => <span key={tag}><Tag size={13} /> {tag}</span>)}</div>
      <textarea className="card-editor" aria-label="Card content" value={card.content} onChange={(event) => setState((current) => updateCard(current, card.id, { content: event.target.value, summary: event.target.value.split("\n")[0] }))} />
      <section className="panel-section">
        <header><h3>Whiteboard locations</h3><button onClick={() => onOpenPanel("locations")}>View all</button></header>
        {locations.map((location) => (
          <button className="location-row" key={location.id} onClick={() => onFocusLocation(location.boardId, location.id)}>
            <MapTrifold size={17} /><span><strong>{location.boardTitle}</strong><small>Placement · {location.x}, {location.y}</small></span><ArrowLeft className="arrow-forward" size={16} />
          </button>
        ))}
        {!locations.length ? <p className="empty-note">This Card is in the Library but not on a Whiteboard.</p> : null}
      </section>
    </div>
  );
}

function LocationsPanel({ state, onFocusLocation }) {
  const card = getCard(state);
  const locations = placementsForCard(state, card.id);
  return (
    <div className="panel-content">
      <div className="panel-kicker"><MapTrifold size={16} /> One Card, many placements</div>
      <h2>{card.title}</h2><p className="panel-intro">Each row is a spatial reference. Editing the Card updates every placement.</p>
      <div className="location-list">
        {locations.map((location, index) => <button key={location.id} onClick={() => onFocusLocation(location.boardId, location.id)}><span className="location-index">{index + 1}</span><span><strong>{location.boardTitle}</strong><small>Focus Card at {location.x}, {location.y}</small></span></button>)}
      </div>
    </div>
  );
}

function LibraryPanel({ state, setState, onOpenCard }) {
  const [query, setQuery] = useState("");
  const [createdTitle, setCreatedTitle] = useState("");
  const board = getBoard(state);
  const visible = state.cards.filter((card) => `${card.title} ${card.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const createCard = () => {
    const title = createdTitle.trim();
    if (!title) return;
    setState((current) => ({
      ...current,
      nextId: current.nextId + 1,
      selectedCardId: `card-${current.nextId}`,
      panel: "card",
      cards: [...current.cards, { id: `card-${current.nextId}`, title, type: "note", tone: "mint", tags: ["Inbox"], summary: "新 Card 已进入统一 Card Library，尚未放入 Whiteboard。", content: "新 Card 已进入统一 Card Library，尚未放入 Whiteboard。" }],
    }));
    setCreatedTitle("");
  };
  return (
    <div className="panel-content library-panel">
      <div className="search-box"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Card Library" /></div>
      <div className="new-card-row"><input value={createdTitle} onChange={(event) => setCreatedTitle(event.target.value)} placeholder="New Card title" onKeyDown={(event) => event.key === "Enter" && createCard()} /><IconButton label="Create Card" onClick={createCard}><Plus size={18} /></IconButton></div>
      <p className="result-count">{visible.length} Cards · shared database</p>
      <div className="library-list">
        {visible.map((card) => {
          const placed = board.placements.some((placement) => placement.cardId === card.id);
          return (
            <article key={card.id}>
              <button className="library-card-main" onClick={() => onOpenCard(card.id)}><span className={`library-tone tone-${card.tone}`} /><span><strong>{card.title}</strong><small>{card.tags.join(" · ")}</small></span></button>
              <button className="place-button" disabled={placed} onClick={() => setState((current) => placeCard(current, board.id, card.id).state)}>{placed ? <><Check size={15} /> On board</> : <><Plus size={15} /> Place</>}</button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ChatPanel({ state, setState }) {
  const [question, setQuestion] = useState("哪些原则能在多个 Project 与个人项目中复用？");
  const chat = state.chat;
  const toggleContext = (cardId) => setState((current) => ({ ...current, chat: { ...current.chat, contexts: current.chat.contexts.includes(cardId) ? current.chat.contexts.filter((id) => id !== cardId) : [...current.chat.contexts, cardId] } }));
  return (
    <div className="panel-content chat-panel">
      <div className="chat-heading"><span><ChatCircleText size={19} /> Research chat</span><button className={`space-search ${chat.spaceSearch ? "active" : ""}`} onClick={() => setState((current) => ({ ...current, chat: { ...current.chat, spaceSearch: !current.chat.spaceSearch } }))} aria-pressed={chat.spaceSearch}><MagnifyingGlass size={16} /> Space search {chat.spaceSearch ? "on" : "off"}</button></div>
      <p className="privacy-note">Current tab name is visible. Content is read only when it appears below as explicit context or in the access log.</p>
      <div className="context-chips" aria-label="Explicit AI context">{state.cards.slice(0, 4).map((card) => <button key={card.id} className={chat.contexts.includes(card.id) ? "selected" : ""} onClick={() => toggleContext(card.id)}>{chat.contexts.includes(card.id) ? <Check size={14} /> : <Plus size={14} />}{card.title}</button>)}</div>
      {chat.audit.length ? <div className="access-log"><strong>AI access log</strong>{chat.audit.map((entry) => <span key={entry}><ClockCounterClockwise size={14} /> {entry}</span>)}</div> : null}
      {chat.response ? (
        <article className="ai-response">
          <div className="candidate-label"><FileText size={15} /> AI candidate · not yet a Card</div><h3>{chat.response.title}</h3><p>{chat.response.body}</p>
          <div className="citation-list">{chat.response.citations.map((citation, index) => <span key={citation}>[{index + 1}] {citation}</span>)}</div>
          <button className="primary-button" onClick={() => setState((current) => saveResponseAsCard(current))}><CardsThree size={17} /> Save as Card with provenance</button>
        </article>
      ) : <div className="chat-empty"><ChatCircleText size={30} /><p>Ask across only the sources you can see.</p></div>}
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); setState((current) => askWithContext(current, question)); }}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} aria-label="Ask about selected context" /><button type="submit" className="primary-button" disabled={!question.trim()}>Ask with {chat.contexts.length} sources</button></form>
    </div>
  );
}

function BoardPanel({ state }) {
  const board = getBoard(state);
  return <div className="panel-content"><div className="panel-kicker"><Info size={16} /> Whiteboard owns placement only</div><h2>{board.title}</h2><dl className="board-facts"><div><dt>Cards placed</dt><dd>{board.placements.length}</dd></div><div><dt>Sections</dt><dd>{board.sections.length}</dd></div><div><dt>Visibility</dt><dd>{board.shared ? "Shared with 2 people" : "Private"}</dd></div></dl><p className="panel-intro">Sections, positions and connections express this board’s context. They do not change a Card’s owner, tags or canonical content.</p></div>;
}

function RightPanel({ state, setState, onClose, onFocusLocation, onOpenCard }) {
  return (
    <aside className={`right-panel panel-${state.panel}`} aria-label="Context sidebar">
      <div className="right-panel-header"><PanelTabs panel={state.panel} onChange={(panel) => setState((current) => ({ ...current, panel }))} /><IconButton label="Close context sidebar" onClick={onClose}><X size={19} /></IconButton></div>
      {state.panel === "card" ? <CardPanel state={state} setState={setState} onOpenPanel={(panel) => setState((current) => ({ ...current, panel }))} onFocusLocation={onFocusLocation} /> : null}
      {state.panel === "locations" ? <LocationsPanel state={state} onFocusLocation={onFocusLocation} /> : null}
      {state.panel === "library" ? <LibraryPanel state={state} setState={setState} onOpenCard={onOpenCard} /> : null}
      {state.panel === "chat" ? <ChatPanel state={state} setState={setState} /> : null}
      {state.panel === "board" ? <BoardPanel state={state} /> : null}
    </aside>
  );
}

function ShareDialog({ state, setState, onClose }) {
  const board = getBoard(state);
  const ajVisible = visibleCardIdsFor(state, "aju").length;
  const dialogRef = useRef(null);
  const boardPermissions = state.permissionsByBoardId[board.id] || {};
  const permissionLabels = { owner: "Owner", edit: "Can edit", view: "Can view", none: "No access" };
  useEffect(() => {
    const previousFocus = document.activeElement;
    const background = [...document.querySelectorAll(".left-sidebar, .workspace, .right-panel, .mobile-nav-scrim")];
    background.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    const dialog = dialogRef.current;
    const focusableSelector = "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";
    const focusable = () => [...dialog.querySelectorAll(focusableSelector)].filter((element) => element.getClientRects().length);
    window.requestAnimationFrame(() => (focusable()[0] || dialog).focus());
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      background.forEach((element) => {
        element.inert = false;
        element.removeAttribute("aria-hidden");
      });
      window.requestAnimationFrame(() => {
        const isVisibleFocusTarget = (element) => (
          element instanceof HTMLElement
          && element.isConnected
          && element.getClientRects().length > 0
          && getComputedStyle(element).visibility !== "hidden"
        );
        if (isVisibleFocusTarget(previousFocus)) {
          previousFocus.focus();
          return;
        }
        const fallback = [...document.querySelectorAll("button[aria-label='Open navigation'], .share-button, button[aria-label='Card Library']")]
          .find(isVisibleFocusTarget);
        fallback?.focus();
      });
    };
  }, []);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
        <header><div><span className="panel-kicker"><ShareNetwork size={15} /> Whiteboard access</span><h2 id="share-title">Share “{board.title}”</h2></div><IconButton label="Close share dialog" onClick={onClose}><X size={20} /></IconButton></header>
        <p>Access is set independently for this Whiteboard. People see its explicitly placed Cards—never the rest of Later’s private Space.</p>
        <div className="permission-list">
          {people.map((person) => {
            const permission = boardPermissions[person.id] || "none";
            return <label key={person.id}><span className="person-mark">{person.name.slice(0, 1)}</span><span><strong>{person.name}</strong><small>{permissionLabels[permission]}</small></span><select aria-label={`${person.name} access for ${board.title}`} value={permission} disabled={person.id === "later"} onChange={(event) => setState((current) => setPermission(current, board.id, person.id, event.target.value))}><option value="owner">Owner</option><option value="edit">Can edit</option><option value="view">Can view</option><option value="none">No access</option></select></label>;
          })}
        </div>
        <div className="visibility-proof"><Info size={18} /><span>阿橘 can currently reach <strong>{ajVisible} of {state.cards.length}</strong> Cards through shared Whiteboards.</span></div>
        <button className="primary-button" onClick={onClose}>Done</button>
      </section>
    </div>
  );
}

export function App() {
  const [state, setState] = useState(createInitialState);
  const [panelOpen, setPanelOpen] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const board = getBoard(state);
  const openPanel = (panel) => { setState((current) => ({ ...current, panel })); setPanelOpen(true); setNavOpen(false); };
  const openCard = (cardId) => { setState((current) => ({ ...current, selectedCardId: cardId, panel: "card" })); setPanelOpen(true); };
  const selectBoard = (boardId) => { setState((current) => ({ ...current, selectedBoardId: boardId, focusedPlacementId: null })); setNavOpen(false); };
  const focusLocation = (boardId, placementId) => { setState((current) => openLocation(current, boardId, placementId)); setPanelOpen(true); };
  return (
    <div className={`heptabase-app ${panelOpen ? "has-panel" : ""} ${navOpen ? "mobile-nav-open" : ""}`}>
      {navOpen ? <button className="mobile-nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} /> : null}
      <LeftSidebar state={state} onSelectBoard={selectBoard} onOpenPanel={openPanel} />
      <main className="workspace"><WorkspaceHeader state={state} board={board} onBack={() => setState((current) => goBack(current))} onOpenPanel={openPanel} onShare={() => setShareOpen(true)} onToggleNav={() => setNavOpen((value) => !value)} /><Canvas state={state} setState={setState} onOpenCard={openCard} onOpenPanel={openPanel} /></main>
      {panelOpen ? <RightPanel state={state} setState={setState} onClose={() => setPanelOpen(false)} onFocusLocation={focusLocation} onOpenCard={openCard} /> : null}
      {shareOpen ? <ShareDialog state={state} setState={setState} onClose={() => setShareOpen(false)} /> : null}
    </div>
  );
}
