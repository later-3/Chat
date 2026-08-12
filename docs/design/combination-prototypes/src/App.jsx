import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarBlank,
  CardsThree,
  CheckCircle,
  FolderOpen,
  House,
  ListChecks,
  Notebook,
  Pulse,
  Robot,
  Stack,
  Palette,
} from "@phosphor-icons/react";
import {
  compositions,
  getComposition,
  getInitialRoute,
  referenceUrl,
  routeUrl,
  sceneCatalog,
  sourceCatalog,
  themeCatalog,
} from "./model.js";

const sceneIcons = {
  projects: House,
  room: FolderOpen,
  work: ListChecks,
  updates: Pulse,
  today: CheckCircle,
  calendar: CalendarBlank,
  agents: Robot,
  knowledge: CardsThree,
};

const sceneOrder = ["projects", "room", "work", "updates", "today", "calendar", "agents", "knowledge"];

function composeReferenceRoute(composition, sourceId, activeSceneId) {
  if (composition.scenes[activeSceneId]?.source === sourceId) return composition.scenes[activeSceneId].route;
  const fallback = sceneOrder.find((sceneId) => composition.scenes[sceneId]?.source === sourceId);
  return fallback ? composition.scenes[fallback].route : "";
}

function CompositionChooser({ activeId, onChange }) {
  return (
    <div className="composition-chooser" aria-label="组合骨架">
      <span className="chooser-label">组合骨架</span>
      <div className="composition-options">
        {compositions.map((composition) => (
          <button
            type="button"
            key={composition.id}
            className={composition.id === activeId ? "is-active" : ""}
            aria-pressed={composition.id === activeId}
            onClick={() => onChange(composition.id)}
          >
            <span>{composition.rank}</span>
            <strong>{composition.shortName}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function SceneNavigation({ composition, activeSceneId, onChange }) {
  return (
    <nav className="scene-navigation" aria-label="完整应用场景">
      {sceneOrder.map((sceneId, index) => {
        const scene = sceneCatalog[sceneId];
        const owner = sourceCatalog[composition.scenes[sceneId].source];
        const Icon = sceneIcons[sceneId];
        const selected = sceneId === activeSceneId;
        return (
          <button
            type="button"
            key={sceneId}
            title={`${scene.label} · ${owner.label}`}
            className={selected ? "is-active" : ""}
            aria-current={selected ? "page" : undefined}
            aria-keyshortcuts={`Alt+${index + 1}`}
            onClick={() => onChange(sceneId)}
          >
            <Icon size={18} weight={selected ? "fill" : "regular"} aria-hidden="true" />
            <span>
              <strong>{scene.label}</strong>
              <small>{owner.label}</small>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function ThemeChooser({ activeId, onChange }) {
  return (
    <div className="theme-chooser" aria-label="视觉主题">
      <span className="theme-chooser__label"><Palette size={16} aria-hidden="true" />主题</span>
      <div className="theme-options">
        {themeCatalog.map((theme) => (
          <button
            type="button"
            key={theme.id}
            className={theme.id === activeId ? "is-active" : ""}
            data-theme-option={theme.id}
            title={`${theme.label} · ${theme.description}`}
            aria-label={`${theme.label}：${theme.description}`}
            aria-pressed={theme.id === activeId}
            onClick={() => onChange(theme.id)}
          >
            <span aria-hidden="true">{theme.shortLabel}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ActiveContext({ composition, sceneId }) {
  const scene = sceneCatalog[sceneId];
  const owner = sourceCatalog[composition.scenes[sceneId].source];
  const portfolioOwner = sourceCatalog[composition.ownership.project_portfolio].label;
  const workOwner = sourceCatalog[composition.ownership.work_execution].label;
  return (
    <div className="active-context">
      <div className="context-copy">
        <span className="source-badge">直接复用 · {owner.label}</span>
        <strong>{scene.label}</strong>
        <span>{scene.description}</span>
      </div>
      <div className="context-boundary" title={composition.summary}>
        <Stack size={17} aria-hidden="true" />
        <span>Projects · {portfolioOwner}&nbsp;&nbsp; Work · {workOwner}</span>
      </div>
    </div>
  );
}

function ReferenceFrame({ source, composition, initialRoute, initialTheme, active, register, onLoad }) {
  // Capture the first URL once. Later scene/theme changes are delivered by postMessage so
  // the reused prototype keeps its local interaction state instead of being reloaded.
  const [initialUrl] = useState(() => referenceUrl(source.id, composition.id, initialRoute, initialTheme));
  return (
    <iframe
      ref={register}
      className={`reference-frame reference-frame--${source.id}`}
      src={initialUrl}
      title={`${source.label} · ${source.role}`}
      hidden={!active}
      aria-hidden={!active}
      tabIndex={active ? 0 : -1}
      onLoad={onLoad}
    />
  );
}

function ReferenceFrames({ composition, sceneId, themeId, onNavigate }) {
  const refs = useRef({});
  const themeRef = useRef(themeId);
  themeRef.current = themeId;
  const activeSourceId = composition.scenes[sceneId].source;

  const sendRoute = useCallback(
    (sourceId) => {
      const frame = refs.current[sourceId];
      if (!frame?.contentWindow) return;
      const route = composeReferenceRoute(composition, sourceId, sceneId);
      const currentTheme = themeRef.current;
      frame.contentWindow.postMessage(
        {
          type: "chat:route",
          source: sourceId,
          compositionId: composition.id,
          themeId: currentTheme,
          url: referenceUrl(sourceId, composition.id, route, currentTheme),
        },
        window.location.origin,
      );
    },
    [composition, sceneId],
  );

  const sendTheme = useCallback((sourceId) => {
    const frame = refs.current[sourceId];
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: "chat:theme", source: sourceId, themeId },
      window.location.origin,
    );
  }, [themeId]);

  useEffect(() => {
    sendRoute(activeSourceId);
  }, [activeSourceId, sendRoute]);

  useEffect(() => {
    sendTheme(activeSourceId);
  }, [activeSourceId, sendTheme]);

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== window.location.origin || !["chat:navigate", "chat:route"].includes(event.data?.type)) return;
      let requestedScene = event.data.scene;
      if (!requestedScene && typeof event.data.url === "string") {
        requestedScene = new URL(event.data.url, window.location.origin).searchParams.get("scene");
      }
      if (composition.scenes[requestedScene]) onNavigate(requestedScene);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [composition, onNavigate]);

  return (
    <div className="reference-frame-stack">
      {Object.values(sourceCatalog).map((source) => {
        const active = source.id === activeSourceId;
        // A direct deep-link must paint the requested scene on the very first frame. Hidden
        // sources still start at their canonical fallback and are routed when activated.
        const initialRoute = composeReferenceRoute(composition, source.id, sceneId);
        return (
          <ReferenceFrame
            key={`${composition.id}:${source.id}`}
            source={source}
            composition={composition}
            initialRoute={initialRoute}
            initialTheme={themeId}
            active={active}
            register={(node) => {
              if (node) refs.current[source.id] = node;
            }}
            onLoad={() => {
              sendRoute(source.id);
              window.setTimeout(() => sendRoute(source.id), 140);
            }}
          />
        );
      })}
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState(getInitialRoute);
  const composition = useMemo(() => getComposition(route.compositionId), [route.compositionId]);

  const navigate = useCallback((next, mode = "push") => {
    setRoute((current) => {
      const complete = { ...current, ...next };
      const url = routeUrl(complete);
      if (mode === "replace") window.history.replaceState({ literalComposition: true, route: complete }, "", url);
      else window.history.pushState({ literalComposition: true, route: complete }, "", url);
      return complete;
    });
  }, []);

  const chooseComposition = useCallback((compositionId) => {
    const next = getComposition(compositionId);
    navigate({ compositionId: next.id, sceneId: next.defaultScene });
  }, [navigate]);

  const chooseScene = useCallback((sceneId) => {
    navigate({ sceneId });
  }, [navigate]);

  const chooseTheme = useCallback((themeId) => {
    navigate({ themeId });
  }, [navigate]);

  useEffect(() => {
    if (!window.history.state?.literalComposition) {
      window.history.replaceState({ literalComposition: true, route }, "", routeUrl(route));
    }
    const onPopState = () => setRoute(getInitialRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < sceneOrder.length) {
        event.preventDefault();
        chooseScene(sceneOrder[index]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseScene]);

  const activeSource = sourceCatalog[composition.scenes[route.sceneId].source];

  return (
    <div className="literal-composition-app" data-composition={composition.id} data-theme={route.themeId}>
      <header className="composition-header">
        <div className="product-mark">
          <span className="product-symbol"><Notebook size={20} weight="fill" aria-hidden="true" /></span>
          <span><strong>Chat</strong><small>Reference composition lab</small></span>
        </div>
        <CompositionChooser activeId={composition.id} onChange={chooseComposition} />
        <ThemeChooser activeId={route.themeId} onChange={chooseTheme} />
        <div className="current-owner" aria-label={`当前场景来自 ${activeSource.label}`}>
          <span>{route.sceneId === composition.defaultScene ? "默认入口" : "当前场景"}</span>
          <strong>{activeSource.label}</strong>
          <ArrowRight size={16} aria-hidden="true" />
        </div>
      </header>
      <div className="application-body">
        <SceneNavigation composition={composition} activeSceneId={route.sceneId} onChange={chooseScene} />
        <section className="prototype-stage" aria-label={`${composition.name} 完整组合原型`}>
          <ActiveContext composition={composition} sceneId={route.sceneId} />
          <ReferenceFrames composition={composition} sceneId={route.sceneId} themeId={route.themeId} onNavigate={chooseScene} />
        </section>
      </div>
    </div>
  );
}
