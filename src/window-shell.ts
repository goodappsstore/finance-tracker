import { getCurrentWindow } from "@tauri-apps/api/window";

export function titlebarHtml(): string {
  const platform = /Mac/i.test(navigator.platform) ? "macos" : "other";
  const control = (action: string, label: string, path: string) =>
    `<button type="button" class="window-control window-control-${action}" data-window-action="${action}" title="${label}" aria-label="${label}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${path}</svg></button>`;
  return `<header class="window-titlebar" data-platform="${platform}" data-tauri-drag-region>
    <span class="titlebar-caption">Finance Tracker</span>
    <div class="window-controls" aria-label="Window controls">
      ${control("minimize", "Minimize window", '<path d="M3 8h10"/>')}
      ${control("maximize", "Maximize or restore window", '<rect x="3" y="3" width="10" height="10" rx="1"/>')}
      ${control("close", "Close window", '<path d="m4 4 8 8m0-8-8 8"/>')}
    </div>
  </header>`;
}

export function bindTitlebar(root: HTMLElement, onError: (message: string) => void): void {
  const appWindow = getCurrentWindow();
  root.querySelectorAll<HTMLButtonElement>("[data-window-action]").forEach(button => {
    button.addEventListener("click", () => {
      const action = button.dataset.windowAction;
      const operation = action === "close" ? appWindow.close()
        : action === "minimize" ? appWindow.minimize() : appWindow.toggleMaximize();
      void operation.catch(error => onError(String(error)));
    });
  });
}

let drawerCleanup: (() => void) | undefined;

export function bindNavigationDrawer(root: HTMLElement): void {
  drawerCleanup?.();
  const shell = root.querySelector<HTMLElement>(".app")!;
  const sidebar = root.querySelector<HTMLElement>("#app-sidebar")!;
  const toggle = root.querySelector<HTMLButtonElement>("#btn-menu")!;
  const main = root.querySelector<HTMLElement>("#main")!;
  const compact = window.matchMedia("(max-width: 900px)");
  let opened = false;
  const setOpen = (value: boolean) => {
    opened = value && compact.matches;
    shell.classList.toggle("navigation-open", opened);
    toggle.setAttribute("aria-expanded", String(opened));
    toggle.setAttribute("aria-label", opened ? "Close navigation" : "Open navigation");
    toggle.title = opened ? "Close navigation" : "Open navigation";
    main.inert = opened;
    if (opened) sidebar.querySelector<HTMLButtonElement>(".nav-item.active, .nav-item")?.focus();
  };
  const close = () => { setOpen(false); toggle.focus(); };
  toggle.addEventListener("click", () => setOpen(!opened));
  root.querySelector(".sidebar-backdrop")!.addEventListener("click", close);
  sidebar.addEventListener("click", event => {
    if (opened && (event.target as HTMLElement).closest("button")) close();
  });
  const keydown = (event: KeyboardEvent) => {
    if (!opened) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      const buttons = [toggle, ...sidebar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
  };
  const resize = () => {
    const focusWasInSidebar = sidebar.contains(document.activeElement);
    setOpen(false);
    if (compact.matches && focusWasInSidebar) toggle.focus();
  };
  root.addEventListener("keydown", keydown);
  compact.addEventListener("change", resize);
  drawerCleanup = () => {
    root.removeEventListener("keydown", keydown);
    compact.removeEventListener("change", resize);
  };
}
