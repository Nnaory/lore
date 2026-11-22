'use client';

/**
 * The answer state machine (DESIGN-SYSTEM §4.9, "highlight → lock"):
 *   idle ──select(x)──▶ focus(x) ──select(x) again / Enter──▶ lock(x)
 *   lock(correct)  → solved (all other options disabled)
 *   lock(wrong)    → x added to `wrong` (disabled for good), HP −1 via onLock, back to idle
 * No submit button exists. Keys 1–4 highlight, Enter locks the highlighted option.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChoiceOption } from '@/lib/schemas/visual';

export interface AnswerFlow {
  focus: string | null;
  /** last locked option id (correct or wrong) */
  locked: string | null;
  wrong: string[];
  solved: boolean;
  select: (id: string) => void;
  reset: () => void;
}

export function useAnswerFlow(options: ChoiceOption[], onLock: (opt: ChoiceOption) => void, { keyboard = true } = {}): AnswerFlow {
  const [focus, setFocus] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [wrong, setWrong] = useState<string[]>([]);
  const solved = !!locked && !!options.find((o) => o.id === locked)?.correct;

  const select = useCallback(
    (id: string) => {
      if (solved || wrong.includes(id)) return;
      if (focus !== id) {
        setFocus(id);
        setLocked(null);
        return;
      }
      const opt = options.find((o) => o.id === id);
      if (!opt) return;
      setLocked(id);
      if (opt.correct) setFocus(id);
      else {
        setWrong((w) => [...w, id]);
        setFocus(null);
      }
      onLock(opt);
    },
    [focus, solved, wrong, options, onLock],
  );

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) select(options[n - 1].id);
      else if (e.key === 'Enter' && focus) select(focus);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, options, focus, select]);

  const reset = useCallback(() => {
    setFocus(null);
    setLocked(null);
    setWrong([]);
  }, []);

  return { focus, locked, wrong, solved, select, reset };
}

export type OptionState = 'idle' | 'focus' | 'correct' | 'rejected' | 'disabled';

export function optionState(flow: AnswerFlow, opt: ChoiceOption): OptionState {
  if (flow.solved) return opt.id === flow.locked ? 'correct' : 'disabled';
  if (flow.wrong.includes(opt.id)) return 'rejected';
  return flow.focus === opt.id ? 'focus' : 'idle';
}
