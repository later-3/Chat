import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  CircleDot,
  FileText,
  FolderKanban,
  Lightbulb,
  RefreshCw,
  Search,
  Sparkles,
  Sprout,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getHomeOverview,
  type HomeCalendarDay,
  type HomeContinueItem,
  type HomeOverview,
  type HomeSearchResult,
  searchHomeResources,
} from "./home-api";
import "./home.css";

interface HomeViewProps {
  onContinue: (item: HomeContinueItem) => void;
  onOpenArtifacts: () => void;
  onOpenGarden: () => void;
  onOpenProjects: () => void;
  searchQuery: string;
}

const STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  blocked: "受阻",
  candidate: "候选",
  draft: "草稿",
  in_progress: "推进中",
  paused: "已暂停",
  planned: "已计划",
  proposed: "待确认",
  ready: "可开始",
  retained: "已保留",
  accepted: "已接受",
};

const KIND_LABELS: Record<string, string> = {
  artifact: "产物",
  note: "知识",
  project: "项目",
  work_item: "事项",
};

export function HomeView({
  onContinue,
  onOpenArtifacts,
  onOpenGarden,
  onOpenProjects,
  searchQuery,
}: HomeViewProps) {
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<HomeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void refreshVersion;
    const controller = new AbortController();
    const now = new Date();
    setLoading(true);
    setLoadError(null);
    void getHomeOverview(now.getFullYear(), -now.getTimezoneOffset(), controller.signal)
      .then((value) => {
        setOverview(value);
        setSelectedDate(
          value.calendar_days.some((day) => day.date === value.today)
            ? value.today
            : (value.calendar_days.at(-1)?.date ?? value.today),
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "加载主页失败");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [refreshVersion]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchHomeResources(query, controller.signal)
        .then(setSearchResults)
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setSearchResults([]);
        })
        .finally(() => setSearching(false));
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  if (loading && !overview) return <HomeLoading />;
  if (loadError && !overview) {
    return (
      <main className="home-view home-state" aria-live="polite">
        <strong>主页暂时没有加载出来</strong>
        <p>{loadError}</p>
        <button onClick={() => setRefreshVersion((value) => value + 1)} type="button">
          <RefreshCw size={16} /> 重试
        </button>
      </main>
    );
  }
  if (!overview) return null;

  const selectedDay =
    overview.calendar_days.find((day) => day.date === selectedDate) ??
    emptyCalendarDay(selectedDate ?? overview.today);

  return (
    <main className="home-view">
      {searchQuery.trim().length >= 2 ? (
        <SearchResults
          loading={searching}
          onOpen={(result) => {
            if (result.kind === "note") onOpenGarden();
            else onOpenProjects();
          }}
          query={searchQuery}
          results={searchResults}
        />
      ) : null}

      <section className="home-hero">
        <div>
          <span className="home-hero__kicker">
            <Sparkles size={17} /> 今天也从一件值得继续的事开始
          </span>
          <h1>
            早上好，Later
            <br />
            <em>今天想把什么变得更好？</em>
          </h1>
          <p>你的对话、项目、学习和灵感，会在这里连成一条可继续、可追溯的协作时间线。</p>
        </div>
        <div className="home-today-orbit">
          <span>{formatShortDate(overview.today)}</span>
          <strong>今天</strong>
          <p>{overview.today_summary.open_work_count} 项开放事项</p>
          <div>
            <span>{overview.today_summary.collaboration_count} 次协作</span>
            <span>{overview.today_summary.new_idea_count} 个新灵感</span>
          </div>
          {overview.today_summary.pending_decision_count > 0 ? (
            <small>{overview.today_summary.pending_decision_count} 个决定待处理</small>
          ) : null}
        </div>
      </section>

      <section className="home-continue-section">
        <header className="home-title-row">
          <div>
            <span>继续</span>
            <h2>不必重新交代，从上次的位置接着来</h2>
          </div>
          <button className="home-text-button" onClick={onOpenProjects} type="button">
            全部事项 <ArrowRight size={16} />
          </button>
        </header>
        {overview.continue_items.length > 0 ? (
          <div className="home-continue-grid">
            {overview.continue_items.map((item, index) => (
              <article
                className={`home-continue-card home-continue-card--${index % 2 ? "blue" : "teal"}`}
                key={`${item.resource_kind}:${item.id}`}
              >
                <span className="home-continue-card__icon">
                  <FolderKanban size={22} />
                </span>
                <div className="home-continue-card__copy">
                  <small>
                    {KIND_LABELS[item.resource_kind]} · {relativeTime(item.updated_at)}
                  </small>
                  <h3>{item.title}</h3>
                  <p>{item.objective}</p>
                  <span className="home-status-pill">
                    {STATUS_LABELS[item.status] ?? item.status}
                  </span>
                  {item.project_title && item.project_title !== item.title ? (
                    <span className="home-project-label">归属 {item.project_title}</span>
                  ) : null}
                </div>
                <button
                  aria-label={`继续 ${item.title}`}
                  onClick={() => onContinue(item)}
                  type="button"
                >
                  继续 <ArrowRight size={17} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <HomeEmptyState
            title="还没有可继续的事项"
            detail="从一次对话开始，确认后的 Project 和 Work 会出现在这里。"
          />
        )}
      </section>

      <CalendarCard
        days={overview.calendar_days}
        onSelect={setSelectedDate}
        selectedDay={selectedDay}
        year={overview.year}
      />

      <section className="home-weekly-card">
        <header className="home-section-heading">
          <span className="home-section-icon home-section-icon--coral">
            <CircleDot size={20} />
          </span>
          <div>
            <h2>本周轨迹</h2>
            <p>只呈现已经发生的可追溯协作，不计算效率分数。</p>
          </div>
        </header>
        <WeeklyTrail days={overview.calendar_days} today={overview.today} />
      </section>

      <section className="home-lower-grid">
        <article className="home-collection-card">
          <header className="home-section-heading">
            <span className="home-section-icon home-section-icon--blue">
              <FileText size={20} />
            </span>
            <div>
              <h2>最近产物</h2>
              <p>这里仅列出 Artifact 事实；在线预览仍在接入。</p>
            </div>
            <button className="home-text-button" onClick={onOpenArtifacts} type="button">
              打开运行工作台
            </button>
          </header>
          {overview.recent_artifacts.length > 0 ? (
            <div className="home-output-list">
              {overview.recent_artifacts.map((artifact) => (
                <button
                  className="home-output-item"
                  disabled
                  key={artifact.id}
                  title="产物在线预览接入中"
                  type="button"
                >
                  <span className="home-output-mark">
                    <FileText size={18} />
                  </span>
                  <span>
                    <strong>{artifact.title}</strong>
                    <small>
                      {artifact.kind} · {STATUS_LABELS[artifact.status] ?? artifact.status} ·{" "}
                      {relativeTime(artifact.updated_at)}
                    </small>
                  </span>
                  <em>预览接入中</em>
                </button>
              ))}
            </div>
          ) : (
            <HomeEmptyState
              title="还没有可展示产物"
              detail="这不是示例空态：当前 Artifact Store 没有可展示记录。"
            />
          )}
        </article>

        <article className="home-collection-card home-idea-card">
          <header className="home-section-heading">
            <span className="home-section-icon home-section-icon--yellow">
              <Lightbulb size={20} />
            </span>
            <div>
              <h2>灵感花园</h2>
              <p>真实 Idea Note 可以先活下来，不必立刻变成任务。</p>
            </div>
            <button
              aria-label="打开知识工作台记录灵感"
              className="home-round-button"
              onClick={onOpenGarden}
              type="button"
            >
              <Sprout size={17} />
            </button>
          </header>
          {overview.ideas.length > 0 ? (
            <div className="home-idea-list">
              {overview.ideas.map((idea) => (
                <button key={idea.id} onClick={onOpenGarden} type="button">
                  <span className="home-idea-seed">
                    <Sprout size={18} />
                  </span>
                  <span>
                    <strong>{idea.title}</strong>
                    <small>{relativeTime(idea.updated_at)}</small>
                  </span>
                  <em>{idea.status === "draft" ? "待培育" : "生长中"}</em>
                </button>
              ))}
            </div>
          ) : (
            <HomeEmptyState
              title="花园里还没有灵感"
              detail="打开知识工作台，可记录一条 Idea Note。升级为 Work 的治理链路稍后接入。"
            />
          )}
        </article>
      </section>
    </main>
  );
}

function CalendarCard({
  days,
  onSelect,
  selectedDay,
  year,
}: {
  days: HomeCalendarDay[];
  onSelect: (date: string) => void;
  selectedDay: HomeCalendarDay;
  year: number;
}) {
  const cells = useMemo(() => calendarCells(year, days), [days, year]);
  return (
    <section className="home-activity-card">
      <header className="home-section-heading">
        <span className="home-section-icon home-section-icon--teal">
          <CalendarDays size={20} />
        </span>
        <div>
          <h2>年度协作日历</h2>
          <p>颜色只表示这一天发生了什么层级的真实活动，不是效率评分。</p>
        </div>
        <span className="home-live-badge">真实数据 · {year}</span>
      </header>
      <div className="home-calendar-scroll">
        <div className="home-calendar-weekdays" aria-hidden="true">
          <span>一</span>
          <span>三</span>
          <span>五</span>
          <span>日</span>
        </div>
        <div className="home-calendar-body">
          <div className="home-calendar-months" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <span key={`month-${index + 1}`}>{index + 1}月</span>
            ))}
          </div>
          <fieldset className="home-heatmap" aria-label={`${year} 年协作活动`}>
            {cells.map((cell, index) =>
              cell ? (
                <button
                  aria-label={`${formatChineseDate(cell.date)}，${cell.summary}`}
                  aria-pressed={selectedDay.date === cell.date}
                  className={`home-heat-cell home-heat-cell--${cell.level}`}
                  key={cell.date}
                  onClick={() => onSelect(cell.date)}
                  title={`${formatChineseDate(cell.date)} · ${cell.summary}`}
                  type="button"
                />
              ) : (
                <span
                  className="home-heat-cell home-heat-cell--blank"
                  key={`leading-${year}-${index}`}
                />
              ),
            )}
          </fieldset>
        </div>
      </div>
      <div className="home-calendar-detail">
        <span>
          <CircleDot size={16} /> {formatChineseDate(selectedDay.date)}
        </span>
        <p>{selectedDay.summary}</p>
        <button disabled title="完整 Conversation Day 需要后端时间导航与跨会话索引" type="button">
          完整协作日接入中 <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function WeeklyTrail({ days, today }: { days: HomeCalendarDay[]; today: string }) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const dates = Array.from({ length: 7 }, (_, index) => addDays(today, index - 6));
  return (
    <div className="home-weekly-trail">
      {dates.map((date) => {
        const day = byDate.get(date) ?? emptyCalendarDay(date);
        return (
          <div key={date}>
            <span>{formatWeekday(date)}</span>
            <i style={{ height: `${Math.max(8, day.level * 18)}px` }} />
            <small>{day.source_count}</small>
          </div>
        );
      })}
    </div>
  );
}

function SearchResults({
  loading,
  onOpen,
  query,
  results,
}: {
  loading: boolean;
  onOpen: (result: HomeSearchResult) => void;
  query: string;
  results: HomeSearchResult[];
}) {
  return (
    <section aria-live="polite" className="home-search-results">
      <header>
        <Search size={17} />
        <strong>“{query.trim()}” 的资源结果</strong>
        <span>{loading ? "搜索中…" : `${results.length} 项`}</span>
      </header>
      {!loading && results.length === 0 ? <p>现有 Project、Work 和 Note 中没有匹配项。</p> : null}
      {results.map((result) => (
        <button key={`${result.kind}:${result.id}`} onClick={() => onOpen(result)} type="button">
          <span>{KIND_LABELS[result.kind]}</span>
          <strong>{result.title}</strong>
          <small>{result.summary}</small>
          <ChevronRight size={16} />
        </button>
      ))}
    </section>
  );
}

function HomeLoading() {
  return (
    <main className="home-view home-state" role="status">
      <RefreshCw className="home-spin" size={22} />
      <strong>正在整理你的协作主页</strong>
      <p>读取 Project、Work、活动和知识事实…</p>
    </main>
  );
}

function HomeEmptyState({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="home-empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function calendarCells(year: number, days: HomeCalendarDay[]): Array<HomeCalendarDay | null> {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = new Date(Date.UTC(year, 0, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(year + 1, 0, 0));
  const count = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  const cells: Array<HomeCalendarDay | null> = Array.from({ length: leading }, () => null);
  for (let index = 0; index < count; index += 1) {
    const date = new Date(Date.UTC(year, 0, index + 1)).toISOString().slice(0, 10);
    cells.push(byDate.get(date) ?? emptyCalendarDay(date));
  }
  return cells;
}

function emptyCalendarDay(date: string): HomeCalendarDay {
  return {
    date,
    level: 0,
    interaction_count: 0,
    work_change_count: 0,
    knowledge_change_count: 0,
    idea_count: 0,
    artifact_count: 0,
    source_count: 0,
    source_refs: [],
    summary: "当天没有记录到活动",
  };
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function formatWeekday(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

function formatChineseDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${month} / ${day}`;
}

function relativeTime(timestamp: string): string {
  const delta = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 1) return "刚刚";
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30
    ? `${days} 天前`
    : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(
        new Date(timestamp),
      );
}
