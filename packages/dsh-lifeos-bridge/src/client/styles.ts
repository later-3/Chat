import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";

const PLUGIN_ID = "@chat/dsh-lifeos-bridge";
const STYLE_ID = `${PLUGIN_ID}/dock`;

const CSS = `
.lifeos-card{box-sizing:border-box;width:calc(100% - 32px);max-width:calc(var(--dsh-composer-card-max-width,820px) - 16px);margin:0 auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}
.lifeos-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.lifeos-header strong{font-size:13px;font-weight:600}.lifeos-status{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.lifeos-plan{margin-top:10px}.lifeos-objective{font-weight:600}.lifeos-summary{margin-top:4px;color:var(--dsw-alias-label-secondary)}.lifeos-plan ol{display:grid;gap:6px;margin:10px 0 0;padding-left:22px}.lifeos-plan li span{display:block}.lifeos-plan li small{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.lifeos-review{margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}.lifeos-review textarea{box-sizing:border-box;width:100%;min-height:72px;padding:9px 10px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}.lifeos-review textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.lifeos-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:8px}.lifeos-actions button{min-height:44px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.lifeos-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.lifeos-actions button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.lifeos-actions button:disabled{opacity:.45;cursor:default}.lifeos-actions .lifeos-primary{border-color:transparent;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}
.lifeos-warning,.lifeos-error{margin:10px 0 0}.lifeos-warning{color:var(--dsw-alias-state-warning-primary)}.lifeos-error{color:var(--dsw-alias-state-error-primary)}
.lifeos-workflow{display:inline-flex;min-width:0;flex:none;font-size:13px}.lifeos-workflow-toggle{display:inline-flex;align-items:center;gap:4px;max-width:180px;height:28px;padding:0 6px 0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}.lifeos-workflow-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.lifeos-workflow-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.lifeos-workflow-toggle:disabled{opacity:.5;cursor:default}.lifeos-workflow-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lifeos-workflow-chevron{flex:none;transition:transform .12s ease}.lifeos-workflow-chevron[data-open="true"]{transform:rotate(180deg)}.lifeos-workflow-option-copy{display:flex;min-width:0;align-items:baseline;justify-content:space-between;gap:14px}.lifeos-workflow-option-copy>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lifeos-workflow-option-copy small{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}.lifeos-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.lifeos-workbench-entry{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;width:36px;height:36px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.lifeos-workbench-entry[data-wide="true"]{justify-content:flex-start;width:100%;padding:0 12px}.lifeos-workbench-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.lifeos-workbench-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.lifeos-workbench-surface{position:fixed;inset:0;display:grid;grid-template-rows:48px minmax(0,1fr);pointer-events:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);opacity:1;visibility:visible;transition:opacity .12s ease;z-index:1000}.lifeos-workbench-surface[data-open="false"]{pointer-events:none;opacity:0;visibility:hidden}.lifeos-workbench-toolbar{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}.lifeos-workbench-toolbar strong{font-size:13px;text-align:center}.lifeos-workbench-back,.lifeos-workbench-new-tab{width:max-content;min-height:32px;display:inline-flex;align-items:center;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-decoration:none;cursor:pointer}.lifeos-workbench-back:hover,.lifeos-workbench-new-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.lifeos-workbench-back:focus-visible,.lifeos-workbench-new-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.lifeos-workbench-new-tab{justify-self:end}.lifeos-workbench-frame{display:block;width:100%;height:100%;border:0;background:#1e1e1e}
@media(max-width:600px){.lifeos-card{width:calc(100% - 16px);padding:12px}.lifeos-actions{display:grid;grid-template-columns:1fr}.lifeos-actions button{width:100%}}
`;

export function installStyles(ctx: ClientContext): void {
  ctx.effect(() => {
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null)
      return () => undefined;
    const element = document.createElement("style");
    element.dataset.plugin = PLUGIN_ID;
    element.dataset.pluginCss = STYLE_ID;
    element.textContent = CSS;
    document.head.append(element);
    return () => {
      element.remove();
    };
  }, "lifeos bridge: dock styles");
}
