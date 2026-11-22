// Needs the "@/" alias and automatic JSX in vitest config (Next.js projects usually have both).
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BrewingDesktop, BrewingPhone } from '@/components/brew/BrewingScreen';
import { HomeGreeting } from '@/components/home/HomeGreeting';
import { Ending } from '@/components/ending/Ending';
import { RuneBoard } from '@/components/answer/RuneBoard';
import { AnswerMenu, PhonePreview } from '@/components/answer/AnswerMenu';
import { CouncilVoices } from '@/components/answer/CouncilVoices';
import { brewReducer, initialBrewState } from '@/lib/schemas/brew';
import { ChoiceBeatSchema, type CharacterDef } from '@/lib/schemas/visual';
import type { AnswerFlow } from '@/components/answer/useAnswerFlow';

const beat = ChoiceBeatSchema.parse({ kind: 'choice', speaker: 'arion', prompt: 'Mana?', concept: 'vektor baris', canvasLabel: 'segel_dasar', options: [
  { id: 'a', label: 'AB = 7', correct: false, why: 'x', preview: { kind: 'scalar', value: 7, caption: 'satu bilangan' }, voice: { speaker: 'lyra', expression: 'worried', mood: 'ragu', claim: 'c1' } },
  { id: 'b', label: 'AB = [3, 4]', correct: true, why: 'y', preview: { kind: 'vector2d', x: 3, y: 4, caption: '1×2' }, voice: { speaker: 'eldric', expression: 'calm', mood: 'tenang', claim: 'c2' } },
  { id: 'c', label: 'AB = [[3],[4],[0]]', correct: false, why: 'z', preview: { kind: 'matrix', rows: [[3], [4], [0]], caption: '3×1' }, voice: { speaker: 'nyx', expression: 'smile', mood: 'licik', claim: 'c3' } },
] });
const cast: CharacterDef[] = [
  { id: 'arion', name: 'Arion', role: 'Sang Pemandu', function: 'guide', look: 'hazel' },
  { id: 'lyra', name: 'Lyra', role: 'Rekan', function: 'peer', look: 'mira' },
  { id: 'eldric', name: 'Eldric', role: 'Penjaga', function: 'examiner', look: 'eldric' },
  { id: 'nyx', name: 'Nyx', role: 'Suara Hampa', function: 'rival', look: 'nyx' },
];
const flow = (p: Partial<AnswerFlow>): AnswerFlow => ({ focus: null, locked: null, wrong: [], solved: false, select: () => {}, reset: () => {}, ...p });

describe('SSR smoke', () => {
  it('renders every screen in both languages without throwing', () => {
    let s = brewReducer(initialBrewState, { type: 'start', file: 'a.pdf', pages: 63, genre: 'fantasi', chapters: 3, language: 'id' }, 0);
    s = brewReducer(s, { type: 'concept', label: 'vektor' }, 1);
    s = brewReducer(s, { type: 'awaiting_review' }, 2);
    for (const lang of ['id', 'en'] as const) {
      const noop = () => {};
      const html = [
        renderToString(<BrewingDesktop state={s} lang={lang} worldName="Valoria" onToggleConcept={noop} onProceed={noop} onEnter={noop} />),
        renderToString(<BrewingPhone state={s} lang={lang} worldName="Valoria" onToggleConcept={noop} onProceed={noop} onEnter={noop} />),
        renderToString(<HomeGreeting lang={lang} onBrew={noop} onPlayDemo={noop} />),
        renderToString(<RuneBoard beat={beat} flow={flow({ focus: 'c' })} lang={lang} />),
        renderToString(<RuneBoard beat={beat} flow={flow({ locked: 'b', focus: 'b', solved: true, wrong: ['a'] })} lang={lang} />),
        renderToString(<AnswerMenu beat={beat} flow={flow({ wrong: ['a'], locked: 'a' })} lang={lang} />),
        renderToString(<PhonePreview beat={beat} flow={flow({ focus: 'b' })} lang={lang} progress={40} time="00:06" />),
        renderToString(<CouncilVoices beat={{ ...beat, mode: 'council' }} cast={cast} picked="c" onPick={noop} lang={lang} />),
        renderToString(<Ending lang={lang} onRetry={noop} onNewStory={noop} onViewLog={noop} result={{
          title: 'Penyelamatan Valoria', subtitle: 'Gerbang Vektor', chapters: 3, sourceFile: 'a.pdf', pages: 63, world: 'Valoria', hp: 4, hpMax: 5, firstTryCorrect: 7, questions: 9, minutes: 21,
          concepts: [{ label: 'vektor baris', outcome: 'first' }, { label: 'vektor kolom', outcome: 'weak' }],
          cast: cast.map((def) => ({ def, lesson: 'arah', questions: 2, firstTry: 1, trapsWon: 1, trapsBroken: 2 })) }} />),
        renderToString(<Ending startAtEnd lang={lang} onRetry={noop} onNewStory={noop} onViewLog={noop} result={{
          title: 'T', subtitle: 'S', chapters: 3, sourceFile: 'a.pdf', pages: 63, world: 'V', hp: 4, hpMax: 5, firstTryCorrect: 7, questions: 9, minutes: 21,
          concepts: [{ label: 'vektor kolom', outcome: 'weak' }], cast: cast.map((def) => ({ def, lesson: 'arah', questions: 2, firstTry: 1, trapsWon: 1, trapsBroken: 2 })) }} />),
      ].join('');
      expect(html.length).toBeGreaterThan(5000);
      expect(html).toContain(lang === 'id' ? 'Kau periksa konsepnya' : 'You check the concepts');
      expect(html).toContain(lang === 'id' ? 'TERTIPU' : 'FOOLED');
      expect(html).toContain(lang === 'id' ? 'KISAH TAMAT' : 'THE END');
    }
  });
});
