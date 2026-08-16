export interface WorkbenchSurfaceState {
  readonly open: boolean;
}

type Listener = () => void;

/**
 * Workbench只拥有页面开合状态，不拥有Workspace、文件或Chat产品事实。
 * controller在Client插件生命周期内保持同一实例，因此关闭Surface不会卸载iframe。
 */
export class WorkbenchSurfaceController {
  private state: WorkbenchSurfaceState = Object.freeze({ open: false });
  private readonly listeners = new Set<Listener>();

  snapshot = (): WorkbenchSurfaceState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open = (): void => this.setOpen(true);

  close = (): void => this.setOpen(false);

  private setOpen(open: boolean): void {
    if (this.state.open === open) return;
    this.state = Object.freeze({ open });
    for (const listener of this.listeners) listener();
  }
}
