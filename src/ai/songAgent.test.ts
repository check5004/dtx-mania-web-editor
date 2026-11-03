import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatResult, ToolCall } from './openrouter';
import { AiError } from './openrouter';
import { bestStoreMatch, cleanAgentAnswer, cleanName, cluesText, isGenericName, runSongAgent, searchTerms, splitDash, titleIsFileName, type AgentTools, type SongClues } from './songAgent';
import type { StoreHit } from './songInfo';

const clues = (p: Partial<SongClues> = {}): SongClues => ({
  fileName: 'WADATAKEAKI feat. Hatsune Miku - Bless your breath.mp3',
  folderName: null,
  tags: null,
  tagPicture: false,
  durationSec: 253,
  fields: { title: 'WADATAKEAKI feat. Hatsune Miku - Bless your breath', artist: '', genre: '', bpm: '120' },
  youtube: null,
  ...p,
});

const hit = (title: string, artist: string, durationSec: number, year = '2019'): StoreHit => ({
  title,
  artist,
  album: 'A',
  year,
  date: `${year}-11-08`,
  genre: 'ロック',
  durationSec,
  art: { url: `https://img/${title}/300.jpg`, big: `https://img/${title}/1200.jpg`, label: title, source: 'itunes' },
});

describe('手がかり', () => {
  it('ファイル名から番号や飾りを外す', () => {
    expect(cleanName('03 忘れてやらない.mp3')).toBe('忘れてやらない');
    expect(cleanName('248 - Bless your breath')).toBe('Bless your breath');
    expect(cleanName('女王蜂『メフィスト』Official MV.mp3')).toBe('女王蜂『メフィスト』Official MV');
    expect(cleanName('Mela! (Official Video) [4K].m4a')).toBe('Mela!');
    expect(cleanName('YOASOBI「アイドル」【叩いてみた】.ogg')).toBe('YOASOBI「アイドル」');
    expect(splitDash('WADATAKEAKI feat. Hatsune Miku - Bless your breath')).toEqual(['WADATAKEAKI feat. Hatsune Miku', 'Bless your breath']);
  });
  it('曲名がファイル名の写しかを見分ける', () => {
    expect(titleIsFileName(clues())).toBe(true);
    expect(titleIsFileName(clues({ fields: { title: 'ブレス・ユア・ブレス', artist: '', genre: '', bpm: '' } }))).toBe(false);
  });
  it('検索語はタグ → 譜面の曲名 → ファイル名の順', () => {
    expect(searchTerms(clues())).toEqual(['WADATAKEAKI feat. Hatsune Miku Bless your breath']);
    const t = searchTerms(clues({ tags: { format: 'id3v2', title: 'Mela!', artist: '緑黄色社会' }, fileName: '01 Track01.mp3', fields: { title: '01 Track01', artist: '', genre: '', bpm: '' } }));
    expect(t[0]).toBe('Mela! 緑黄色社会');
  });
  it('AI に渡す文：仮の曲名とタグなしを書く', () => {
    const s = cluesText(clues());
    expect(s).toContain('ファイルのタグ: なし');
    expect(s).toContain('ファイル名から仮に入れたもの');
    expect(s).toContain('4分13秒（253秒）');
  });
  it('長さと名前で iTunes の結果を選ぶ', () => {
    const c = clues();
    const hits = [hit('ブレス・ユア・ブレス-初音ミク「マジカルミライ」Live', '和田たけあき & 初音ミク', 250, '2024'), hit('Bless your breath', 'WADATAKEAKI', 253), hit('Other', 'Someone', 200)];
    expect(bestStoreMatch(hits, c)?.hit.title).toBe('Bless your breath');
    expect(bestStoreMatch([hit('Other', 'Someone', 200)], c)).toBeNull();
    // ゲームサイズ（短い）でも名前が合えば選ぶ。同じくらいなら最初の発売
    const g = clues({ fileName: 'bgm.ogg', durationSec: 92, fields: { title: 'メフィスト', artist: '女王蜂', genre: '', bpm: '' } });
    expect(bestStoreMatch([hit('メフィスト', '女王蜂', 227, '2025'), hit('メフィスト', '女王蜂', 227, '2023')], g)?.hit.year).toBe('2023');
  });
  it('曲を表さない名前は検索に使わない', () => {
    expect(isGenericName('bgm_d.ogg')).toBe(true);
    expect(isGenericName('01 Track01.mp3')).toBe(true);
    expect(isGenericName('drums.wav')).toBe(true);
    expect(isGenericName('Mephisto')).toBe(false);
    expect(searchTerms(clues({ fileName: 'bgm_d.ogg', fields: { title: 'メフィスト', artist: '女王蜂', genre: '', bpm: '' } }))).toEqual(['メフィスト 女王蜂']);
  });
});

describe('答えをそろえる', () => {
  it('YouTube でない URL・重複・飾りのない出典は落とす', () => {
    const a = cleanAgentAnswer({
      title: 'X',
      year: '2019年',
      youtube: [
        { url: 'https://youtu.be/a-Nf3QUFkOU', kind: 'mv', official: true, why: '本人' },
        { url: 'https://www.youtube.com/watch?v=a-Nf3QUFkOU', kind: 'mv', official: true, why: '重複' },
        { url: 'https://example.com/v', kind: 'mv', official: true, why: '' },
      ],
      sources: [{ title: 'p', url: 'https://example.com/a' }, { title: 'bad', url: 'javascript:alert(1)' }],
      jacket: 'it1',
    });
    expect(a.year).toBe('2019');
    expect(a.youtube).toHaveLength(1);
    expect(a.sources).toHaveLength(1);
    expect(a.jacket).toBe('it1');
    expect(a.confidence).toBe('low');
  });
});

/** 決まった順に道具を呼ぶ偽の AI */
function scripted(turns: { text?: string; calls?: [string, object][]; web?: number; reasoning?: boolean }[]) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const call = async (messages: ChatMessage[]): Promise<ChatResult & { costUsed: number }> => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const t = turns[Math.min(i++, turns.length - 1)];
    const toolCalls: ToolCall[] = (t.calls ?? []).map(([name, args], k) => ({ id: `c${i}_${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
    const message: Extract<ChatMessage, { role: 'assistant' }> = { role: 'assistant', content: t.text ?? null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (t.reasoning) message.reasoning_details = [{ type: 'reasoning.text', text: 'r', signature: 's' }];
    return { text: t.text ?? '', model: 'm', citations: [], promptTokens: 100, completionTokens: 10, cost: 0.001, webSearches: t.web ?? 0, finish: 'stop', toolCalls, message, costUsed: 0.001 };
  };
  return { call, seen };
}

const tools = (): AgentTools => ({
  searchItunes: async () => [hit('ブレス・ユア・ブレス', '和田たけあき', 253)],
  checkYoutube: async (url) => (url.includes('a-Nf3QUFkOU') ? { title: 'ブレス・ユア・ブレス MV', channel: '和田たけあき', channelUrl: 'https://www.youtube.com/@WADATAKEAKI' } : null),
  checkImage: async () => null,
});

describe('エージェント', () => {
  it('道具を使って答える。確かめていない・存在しない YouTube は答えから外す', async () => {
    const { call, seen } = scripted([
      { text: '分かったこと → iTunes で探す', calls: [['search_itunes', { term: 'Bless your breath' }]], reasoning: true },
      { text: '公式を確かめる', calls: [['check_youtube', { url: 'https://www.youtube.com/watch?v=a-Nf3QUFkOU' }]], web: 2, reasoning: true },
      {
        calls: [
          [
            'submit_song_info',
            {
              title: 'ブレス・ユア・ブレス',
              title_alt: 'Bless Your Breath',
              artist: '和田たけあき',
              genre: 'ロック',
              year: '2019',
              comment: 'c',
              panel: 'p',
              confidence: 'high',
              notes: '',
              jacket: 'it1',
              youtube: [
                { url: 'https://www.youtube.com/watch?v=a-Nf3QUFkOU', kind: 'mv', official: true, why: '本人' },
                { url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', kind: 'mv', official: true, why: '作り話' },
              ],
              sources: [],
            },
          ],
        ],
      },
    ]);
    const steps: string[] = [];
    const out = await runSongAgent({ clues: clues(), tools: tools(), call, onStep: (s) => s.state !== 'run' && steps.push(`${s.kind}:${s.text}`) });
    expect(out.answer.title).toBe('ブレス・ユア・ブレス');
    expect(out.answer.youtube.map((y) => y.url)).toEqual(['https://www.youtube.com/watch?v=a-Nf3QUFkOU']);
    expect(out.answer.jacket).toBe('it1');
    expect(out.itunes.get('it1')?.title).toBe('ブレス・ユア・ブレス');
    expect(out.turns).toBe(3);
    expect(out.cost).toBeCloseTo(0.003);
    expect(out.webSearches).toBe(2);
    expect(steps.some((s) => s.startsWith('web:Web検索 2回'))).toBe(true);
    // 道具の結果は tool として返す
    const third = seen[2];
    expect(third.filter((m) => m.role === 'tool')).toHaveLength(2);
    // Web 検索をした回の推論の署名は返さない（そのまま返すと提供元に断られる）。しなかった回は返す
    const asst = third.filter((m) => m.role === 'assistant') as Extract<ChatMessage, { role: 'assistant' }>[];
    expect(asst[0].reasoning_details).toBeDefined();
    expect(asst[1].reasoning_details).toBeUndefined();
  });
  it('先に検索した iTunes の結果を手がかりに入れる', async () => {
    const { call, seen } = scripted([{ calls: [['submit_song_info', { title: 'T', jacket: 'it1', youtube: [], sources: [] }]] }]);
    const out = await runSongAgent({ clues: clues(), tools: tools(), call, onStep: () => {}, seed: { term: 'Bless', hits: [hit('ブレス・ユア・ブレス', '和田たけあき', 253)] } });
    expect((seen[0][1] as { content: string }).content).toContain('it1: ブレス・ユア・ブレス / 和田たけあき');
    expect(out.answer.jacket).toBe('it1');
  });
  it('回数の上限に届いたら、道具を使わずに答えるよう頼む。答えなければ候補だけ返す', async () => {
    const { call, seen } = scripted([{ text: 'まだ探す', calls: [['search_itunes', { term: 'x' }]] }]);
    const out = await runSongAgent({ clues: clues(), tools: tools(), call, onStep: () => {}, maxTurns: 3 });
    expect(out.incomplete).toBe(true);
    expect(out.answer.confidence).toBe('low');
    const last = seen[2];
    expect((last[last.length - 1] as { content: string }).content).toContain('道具はここまで');
  });
  it('文で JSON を返してきたらそれを答えにする', async () => {
    const { call } = scripted([{ text: '```json\n{"title":"A","artist":"B","confidence":"medium"}\n```' }]);
    const out = await runSongAgent({ clues: clues(), tools: tools(), call, onStep: () => {} });
    expect(out.answer).toMatchObject({ title: 'A', artist: 'B', confidence: 'medium' });
  });
  it('推論の署名で断られたら、外して1回だけやり直す', async () => {
    let n = 0;
    const base = scripted([
      { calls: [['search_itunes', { term: 'x' }]], reasoning: true },
      { calls: [['submit_song_info', { title: 'OK', youtube: [], sources: [] }]] },
    ]);
    const call = async (messages: ChatMessage[]) => {
      n++;
      if (n === 2 && messages.some((m) => m.role === 'assistant' && m.reasoning_details)) throw new AiError('thinking blocks cannot be modified', 400);
      return base.call(messages);
    };
    const out = await runSongAgent({ clues: clues(), tools: tools(), call, onStep: () => {} });
    expect(out.answer.title).toBe('OK');
    expect(n).toBe(3);
  });
});
