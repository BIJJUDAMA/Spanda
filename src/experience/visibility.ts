export interface VisibilityOptions {
  nowMs: number;
  lastInteractionMs: number;
  focusWithin: boolean;
  menuOpen: boolean;
  hasError: boolean;
}

export function nextControlsVisibility(options: VisibilityOptions): boolean {
  if (options.hasError || options.menuOpen || options.focusWithin) {
    return true;
  }
  return options.nowMs - options.lastInteractionMs < 1000;
}

