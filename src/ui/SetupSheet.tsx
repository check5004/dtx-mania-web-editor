// おまかせで準備の最初の画面：原曲（音声・動画）か、分けてあるステム（Moises など）から、やることを選んで始める。
// やることは全部入った状態で出し、外したい物だけ外す。「自分で入れる」は今までの新しい譜面の画面。
// ステムから始めるときは、名前から見分けた種類を並べ、その場で選び直せる（知らない名前は「その他」にして黄色で知らせる）。
// PC は中央の画面（ステムはドラムとドラム以外の 2 列）、iPad はステムを 1 列に、iPhone は下から出るシート
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tr } from '../i18n';
import { formatUsd } from '../ai/tasks';
import { stemKindInfo, STEM_KINDS } from '../audio/stemNames';
import { isVideoName } from '../audio/videoAudio';
import { isDiskFolder } from '../fs/folder';
import { IS_IOS } from '../platform';
import { taskCostEstimate, useHasAiKey } from '../store/ai';
import { useDevice } from '../store/device';
import { localPlace } from '../store/localSongs';
import type { StemKind } from '../store/sidecar';
import { audioDuration } from '../store/songinfo';
import { plannedBgmName, withOriginal, type SetupDifficulty, type SetupOptions, type SetupSource, type SetupStem } from '../app/setup';
import { customDialog } from './dialogs';
import { Icon } from './icons';

/** auto：おまかせで準備する / manual：自分で入れる（選び直した原曲・ステムの種類は、どちらでも src に入れて返す） */
export type SetupAnswer = { mode: 'auto' | 'manual'; src: SetupSource; opts: SetupOptions };

/** おまかせで準備の画面を出す。やめたら null */
export function setupSheet(src: SetupSource): Promise<SetupAnswer | null> {
  const { phone, tablet } = useDevice.getState();
  const cls = ['setup-sheet', src.kind === 'stems' ? 'stems' : '', phone ? 'phone' : tablet ? 'tablet' : ''].filter(Boolean).join(' ');
  return customDialog<SetupAnswer>((done) => <SetupSheet src={src} done={done} />, { className: cls });
}

export const SETUP_DIFFS: { id: SetupDifficulty; color: string }[] = [
  { id: 'BASIC', color: '#5aa9ff' },
  { id: 'ADVANCED', color: '#ffc768' },
  { id: 'EXTREME', color: '#ff6b74' },
  { id: 'MASTER', color: '#c58cff' },
];

/** 長さの表示（1:05） */
export function lengthText(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** ファイルの長さ（秒。分からなければ 0） */
export function useDuration(file: File | null): number {
  const [d, setD] = useState(0);
  useEffect(() => {
    let alive = true;
    setD(0);
    if (file) void audioDuration(file).then((v) => alive && setD(v));
    return () => {
      alive = false;
    };
  }, [file]);
  return d;
}

/** 長さ・形式・大きさ（1:00 · OGG · 4.2 MB） */
export function fileMeta(file: File, sec: number): string {
  const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? '').toUpperCase();
  const mb = file.size / 1024 / 1024;
  const kind = isVideoName(file.name) ? tr(`動画（${ext}）`, `Video (${ext})`) : ext;
  return [sec > 0 ? lengthText(sec) : '', kind, mb >= 0.1 ? `${mb.toFixed(1)} MB` : ''].filter(Boolean).join(' · ');
}

/** 最初の選び方（やることは全部。ステムから始めるならステム分解は要らない。スマホはステム分解をしない＝メモリが足りない） */
export function defaultSetupOptions(src: SetupSource): SetupOptions {
  return { info: true, ai: true, tempo: true, preview: true, separate: src.kind !== 'stems' && !useDevice.getState().phone, drums: true, difficulty: 'MASTER' };
}

/** 曲情報の項目の説明と目安（AI のキーがあれば Web 検索も） */
export function infoTexts(ai: boolean): { desc: string; short: string; time: string; shortTime: string } {
  const usd = formatUsd(taskCostEstimate('songinfo') ?? 0.04);
  return ai
    ? {
        desc: tr('タグと iTunes、AI の Web 検索で探して入れます。ジャケット・背景画像・公式 YouTube も', 'Searches the tags, iTunes and the web with AI. Adds the jacket, background image and official YouTube too'),
        short: tr('タグ・iTunes・AI の Web 検索で', 'Tags, iTunes and AI web search'),
        time: tr(`約 20 秒 · AI 約 ${usd}`, `About 20 s · AI about ${usd}`),
        shortTime: tr(`約 20 秒 · ${usd}`, `~20 s · ${usd}`),
      }
    : {
        desc: tr(
          'タグと iTunes で探して、曲名・アーティスト・ジャケットを入れます。OpenRouter のキーがあれば、AI の Web 検索で背景画像と公式 YouTube も',
          'Searches the tags and iTunes for the title, artist and jacket. With an OpenRouter key, AI web search also finds the background image and official YouTube',
        ),
        short: tr('タグと iTunes で（無料）', 'Tags and iTunes (free)'),
        time: tr('数秒 · 無料', 'A few seconds · free'),
        shortTime: tr('数秒', 'Seconds'),
      };
}

/** 終わったあと、曲をどこに保存するか */
export function savePlaceText(src: SetupSource): string {
  return isDiskFolder(src.folder)
    ? tr(`終わるとエディタが開きます。曲はこの曲フォルダ（${src.folder.name}）に保存されます`, `The editor opens when it's done. The song is saved in this song folder (${src.folder.name})`)
    : tr(`終わるとエディタが開きます。曲は${localPlace()}に自動で保存されます`, `The editor opens when it's done. The song is saved in ${localPlace()} automatically`);
}

/** 準備の間は画面をつけたまま（iPad・iPhone） */
export const keepOnText = () =>
  tr('準備中は画面をつけたまま、このアプリを開いておいてください。ほかのアプリに切り替えると止まることがあります', 'Keep the screen on and this app open while it sets up. Switching to another app can stop it');

function SetupSheet({ src: first, done }: { src: SetupSource; done: (v: SetupAnswer | null) => void }) {
  return first.kind === 'stems' ? <StemsSheet src={first} done={done} /> : <SourceSheet src={first} done={done} />;
}

/** iPhone のシートのつまみ（見た目だけ） */
export function Grip() {
  return (
    <div className="setup-grip" aria-hidden="true">
      <i />
    </div>
  );
}

/** iPhone：見出しと下のボタンの間だけをスクロールする（「おまかせで準備する」をいつも見せる） */
export function PhoneBody({ phone, children }: { phone: boolean; children: ReactNode }) {
  return phone ? <div className="setup-pbody">{children}</div> : <>{children}</>;
}

function Head({ sub, done }: { sub?: string; done: (v: null) => void }) {
  return (
    <div className="setup-head">
      <div className="grow">
        <h2>{tr('おまかせで準備', 'Set up for me')}</h2>
        {sub && <p>{sub}</p>}
      </div>
      <button className="setup-x" onClick={() => done(null)} aria-label={tr('閉じる', 'Close')} title={tr('閉じる', 'Close')}>
        {Icon.close(16)}
      </button>
    </div>
  );
}

function Foot({ note, phone, disabled, onManual, onGo }: { note: string; phone: boolean; disabled?: boolean; onManual: () => void; onGo: () => void }) {
  const touch = useDevice((s) => s.tablet);
  const goRef = useRef<HTMLButtonElement>(null);
  // PC は Enter で始められるように「おまかせで準備する」に合わせておく（画面が低くても見出しが隠れないよう、スクロールはしない）
  useEffect(() => {
    if (!touch) goRef.current?.focus({ preventScroll: true });
  }, [touch]);
  if (phone)
    return (
      <div className="setup-pfoot">
        <button className="btn primary setup-big setup-go" onClick={onGo} disabled={disabled}>
          {Icon.sparkle(16)}
          {tr('おまかせで準備する', 'Set it up')}
        </button>
        <button className="link-btn setup-manual" onClick={onManual}>
          {tr('自分で入れる', 'Enter it myself')}
        </button>
      </div>
    );
  return (
    <div className="setup-foot">
      <span className="setup-foot-note">{note}</span>
      <button className="btn setup-big ghost" onClick={onManual}>
        {tr('自分で入れる', 'Enter it myself')}
      </button>
      <button ref={goRef} className="btn primary setup-big setup-go" onClick={onGo} disabled={disabled}>
        {Icon.sparkle(16)}
        {tr('おまかせで準備する', 'Set it up')}
      </button>
    </div>
  );
}

export function DiffSeg({ value, set }: { value: SetupDifficulty; set: (d: SetupDifficulty) => void }) {
  return (
    <div className="setup-diff-seg" role="group" aria-label={tr('最初に作る難易度', 'First difficulty to make')}>
      {SETUP_DIFFS.map((d) => (
        <button key={d.id} className={value === d.id ? 'on' : ''} aria-pressed={value === d.id} onClick={() => set(d.id)}>
          <span className="setup-dot" style={{ background: d.color }} />
          {d.id}
        </button>
      ))}
    </div>
  );
}

function DiffSelect({ value, set }: { value: SetupDifficulty; set: (d: SetupDifficulty) => void }) {
  return (
    <select className="field setup-diff-select" value={value} onChange={(e) => set(e.target.value as SetupDifficulty)} aria-label={tr('最初に作る難易度', 'First difficulty to make')}>
      {SETUP_DIFFS.map((d) => (
        <option key={d.id} value={d.id}>
          {d.id}
        </option>
      ))}
    </select>
  );
}

interface StepDef {
  key: 'video' | 'info' | 'tempo' | 'preview' | 'separate' | 'drums';
  title: string;
  /** iPhone の短い見出し（無ければ title） */
  shortTitle?: string;
  desc: string;
  short: string;
  time: string;
  shortTime: string;
  long?: boolean;
}

function sourceSteps(video: boolean, ai: boolean, separate: boolean, phone: boolean): StepDef[] {
  const info = infoTexts(ai);
  const secs = tr('数秒', 'A few seconds');
  return [
    ...(video
      ? [
          {
            key: 'video' as const,
            title: tr('動画から音を取り出す', 'Take the audio out of the video'),
            shortTitle: tr('動画の音を取り出す', 'Video audio'),
            desc: tr('OGG にして原曲に。動画はゲームで譜面の後ろに流す背景動画にもします', 'Saved as OGG and used as the original. The video also plays behind the chart in the game'),
            short: tr('OGG にして原曲・背景動画に', 'OGG original and background movie'),
            time: secs,
            shortTime: tr('数秒', 'Seconds'),
          },
        ]
      : []),
    { key: 'info', title: tr('曲名・アーティスト・画像', 'Title, artist and images'), desc: info.desc, short: info.short, time: info.time, shortTime: info.shortTime },
    {
      key: 'tempo',
      title: tr('テンポと曲の頭', 'Tempo and where the song starts'),
      desc: tr('BPM と曲の始まりを見つけて、グリッドを曲にそろえます', 'Finds the BPM and where the song starts, and lines the grid up with it'),
      short: tr('グリッドを曲にそろえる', 'Lines the grid up with the song'),
      time: secs,
      shortTime: tr('数秒', 'Seconds'),
    },
    {
      key: 'preview',
      title: tr('試聴（サビ）', 'Preview (chorus)'),
      desc: tr('サビを探して、選曲画面で流れる試聴のファイルを作ります', 'Finds the chorus and makes the preview that plays on the song select screen'),
      short: tr('選曲画面で流れる試聴を作る', 'The song select preview'),
      time: secs,
      shortTime: tr('数秒', 'Seconds'),
    },
    // スマホではステム分解をしない（メモリが足りない。分けたステムを一緒に選べば使える）
    ...(phone
      ? []
      : [
          {
            key: 'separate' as const,
            title: tr('ステム分解（ドラムとドラム抜き）', 'Stem separation (drums and no drums)'),
            shortTitle: tr('ステム分解', 'Stem separation'),
            desc: tr('ゲームの BGM はドラム抜きに。エディタでは両方を鳴らし、波形とスペクトルはドラムで', 'The game BGM has no drums. The editor plays both, and the waveform and spectrum show the drums'),
            short: tr('ドラムとドラム抜きに。ゲームの BGM はドラム抜き', 'Drums and no drums. The game BGM has no drums'),
            time: IS_IOS ? tr('10 分を超えることも（いちばん長い）', 'Can take over 10 min (the longest)') : tr('数分（いちばん長い）', 'A few minutes (the longest)'),
            shortTime: IS_IOS ? tr('10 分を超えることも', 'Over 10 min') : tr('数分', 'Minutes'),
            long: true,
          },
        ]),
    {
      key: 'drums',
      title: tr('ドラムの打点', 'Drum hits'),
      desc: separate
        ? tr('分けたドラムから打点を拾って「原曲の打点」の列に。TAB 補完の候補にも使います', 'Picks up the hits from the split drums into the "original hits" columns. Tab completion uses them too')
        : tr('原曲から打点を拾って「原曲の打点」の列に。TAB 補完の候補にも使います', 'Picks up the hits from the original into the "original hits" columns. Tab completion uses them too'),
      short: separate ? tr('分けたドラムから打点を拾う', 'Hits from the split drums') : tr('原曲から打点を拾う', 'Hits from the original'),
      time: tr('十数秒', 'About 10–20 s'),
      shortTime: tr('十数秒', '10–20 s'),
    },
  ];
}

/** 原曲（音声・動画）から */
function SourceSheet({ src: first, done }: { src: SetupSource; done: (v: SetupAnswer | null) => void }) {
  const [src, setSrc] = useState(first);
  const [o, setO] = useState<SetupOptions>(() => defaultSetupOptions(first));
  const ai = useHasAiKey();
  const phone = useDevice((s) => s.phone);
  const file = src.original!;
  const sec = useDuration(file);
  const video = src.kind === 'video';
  const steps = sourceSteps(video, ai, o.separate, phone);
  const isOn = (k: StepDef['key']) => (k === 'video' ? true : o[k]);
  const put = (k: StepDef['key'], v: boolean) => k !== 'video' && setO((x) => ({ ...x, [k]: v }));
  const go = () => done({ mode: 'auto', src, opts: { ...o, ai: o.info && ai } });
  const manual = () => done({ mode: 'manual', src, opts: o });
  const fileCard = (
    <div className="setup-file">
      <span className="setup-file-icon">{video ? Icon.video(22) : Icon.wave(22)}</span>
      <span className="setup-file-text">
        {src.choices.length > 1 ? (
          <select
            className="field setup-file-pick"
            value={src.choices.indexOf(file)}
            onChange={(e) => setSrc(withOriginal(src, src.choices[Number(e.target.value)]))}
            aria-label={tr('原曲にするファイル', 'File to use as the original')}
          >
            {src.choices.map((f, i) => (
              <option key={i} value={i}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="setup-file-name ellipsis">{file.name}</span>
        )}
        <span className="setup-file-meta">{fileMeta(file, sec)}</span>
        {src.movie && !video && <span className="setup-file-meta">{tr(`${src.movie.name} は背景動画に`, `${src.movie.name} becomes the background movie`)}</span>}
      </span>
      {!phone && <span className="setup-badge">{video ? tr('動画', 'Video') : tr('原曲', 'Original')}</span>}
    </div>
  );

  if (phone)
    return (
      <>
        <Grip />
        <Head done={done} />
        <PhoneBody phone>
          {fileCard}
          <div className="setup-plist">
            {steps.map((s) => (
              <label key={s.key} className={`setup-prow ${isOn(s.key) ? '' : 'off'}`}>
                <input type="checkbox" checked={isOn(s.key)} disabled={s.key === 'video'} onChange={(e) => put(s.key, e.target.checked)} />
                <span className="setup-prow-text">
                  <span className="setup-prow-line">
                    <b>{s.shortTitle ?? s.title}</b>
                    <span className={`setup-prow-time ${s.long ? 'long' : ''}`}>{s.shortTime}</span>
                  </span>
                  <span className="setup-prow-sub">{s.short}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="setup-pdiff">
            <span>{tr('最初に作る難易度', 'First difficulty')}</span>
            <DiffSelect value={o.difficulty} set={(d) => setO((x) => ({ ...x, difficulty: d }))} />
          </label>
          <div className="setup-hint">
            {Icon.sliders(16)}
            <span>
              {tr(
                'ステム分解は PC・iPad で。Moises などで分けたステムを原曲と一緒に選ぶと、ドラム抜きの BGM も作れます',
                'Stem separation is on PC or iPad. Choose stems split with an app like Moises together with the original to make the no-drums BGM too',
              )}
            </span>
          </div>
          {IS_IOS && (
            <p className="setup-pwarn">
              {Icon.info(14)}
              <span>{keepOnText()}</span>
            </p>
          )}
        </PhoneBody>
        <Foot note="" phone onManual={manual} onGo={go} />
      </>
    );

  return (
    <>
      <Head sub={tr('原曲から、打ち込みを始められる所までを 1 回でそろえます。どれもあとから変えられます。', 'Gets everything ready to start placing notes from the original, in one go. You can change all of it later.')} done={done} />
      {fileCard}
      <div className="setup-steps">
        <div className="setup-sub-h">
          <b>{tr('やること', 'What it does')}</b>
          <span>{tr('外したものは、あとでエディタからいつでもできます', 'Anything you leave out can be done from the editor later')}</span>
        </div>
        {steps.map((s) => (
          <label key={s.key} className={`setup-step ${isOn(s.key) ? '' : 'off'}`}>
            <input type="checkbox" checked={isOn(s.key)} disabled={s.key === 'video'} onChange={(e) => put(s.key, e.target.checked)} />
            <span className="setup-step-text">
              <span className="setup-step-t">{s.title}</span>
              <span className="setup-step-d">{s.desc}</span>
            </span>
            <span className={`setup-step-time ${s.long ? 'long' : ''}`}>{s.time}</span>
          </label>
        ))}
      </div>

      <div className="setup-diff">
        <b>{tr('最初に作る難易度', 'First difficulty')}</b>
        <DiffSeg value={o.difficulty} set={(d) => setO((x) => ({ ...x, difficulty: d }))} />
        <span className="lbl">{tr('ほかの難易度は、打ち込んだあと AI難易度生成で作れます', 'Make the other difficulties with AI difficulty generation after placing the notes')}</span>
      </div>

      <div className="setup-hint">
        {Icon.sliders(16)}
        <span>
          {tr(
            'Moises などで分けたステムがあるときは、原曲と一緒にまとめて選ぶ（落とす）と、ステム分解を飛ばして準備できます',
            'If you have stems split with an app like Moises, choose (or drop) them together with the original to skip stem separation',
          )}
        </span>
      </div>
      {IS_IOS && (
        <p className="setup-pwarn">
          {Icon.info(14)}
          <span>{keepOnText()}</span>
        </p>
      )}

      <Foot note={savePlaceText(src)} phone={false} onManual={manual} onGo={go} />
    </>
  );
}

type Pick = StemKind | 'unused';

/** ステムの種類の選び方（「使わない」は BGM にも試聴にも混ぜない） */
function KindSelect({ value, set, label, warn }: { value: Pick; set: (k: Pick) => void; label: string; warn?: boolean }) {
  return (
    <select className={`field setup-kind ${warn ? 'warn' : ''}`} value={value} onChange={(e) => set(e.target.value as Pick)} aria-label={tr(`${label} の種類`, `Type of ${label}`)}>
      {STEM_KINDS.map((k) => (
        <option key={k.kind} value={k.kind}>
          {k.label}
        </option>
      ))}
      <option value="unused">{tr('使わない', "Don't use")}</option>
    </select>
  );
}

/** 分けてあるステム（Moises など）から */
function StemsSheet({ src, done }: { src: SetupSource; done: (v: SetupAnswer | null) => void }) {
  const all: SetupStem[] = [...src.stems, ...src.unused];
  const [picks, setPicks] = useState<Map<SetupStem, Pick>>(() => new Map(all.map((s) => [s, src.unused.includes(s) ? 'unused' : s.kind])));
  const [o, setO] = useState<SetupOptions>(() => defaultSetupOptions(src));
  const ai = useHasAiKey();
  const phone = useDevice((s) => s.phone);
  // iPad・iPhone は 1 列（種類ごとの列にせず、行ごとに BGM に・打点に を出す）
  const list = useDevice((s) => s.tablet || s.phone);
  const sec = useDuration(src.original ?? src.stems[0]?.file ?? null);
  const pick = (s: SetupStem) => picks.get(s) ?? s.kind;
  const setPick = (s: SetupStem, k: Pick) => setPicks((m) => new Map(m).set(s, k));
  const used = all.filter((s) => pick(s) !== 'unused');
  const drums = used.filter((s) => pick(s) === 'drums');
  const others = used.filter((s) => pick(s) !== 'drums');
  const unused = all.filter((s) => pick(s) === 'unused');
  const put = (k: keyof SetupOptions) => (v: boolean) => setO((x) => ({ ...x, [k]: v }));
  const edited = (): SetupSource => ({
    ...src,
    stems: used.map((s) => ({ ...s, kind: pick(s) as StemKind, known: s.known || pick(s) !== s.kind })),
    unused,
  });
  const go = () => done({ mode: 'auto', src: edited(), opts: { ...o, ai: o.info && ai } });
  const manual = () => done({ mode: 'manual', src: edited(), opts: o });

  const row = (s: SetupStem) => {
    const k = pick(s);
    // 名前から分からず「その他」にしたまま
    const unknown = !s.known && k === s.kind;
    const role = k === 'unused' ? tr('使わない', 'Not used') : k === 'drums' ? tr('打点・スペクトル', 'Hits, spectrum') : tr('BGM に', 'To BGM');
    return (
      <div key={all.indexOf(s)} className={`setup-stem ${unknown ? 'warn' : ''} ${k === 'unused' ? 'unused' : ''}`}>
        {list && <span className="setup-col-dot" style={k === 'unused' ? undefined : { background: stemKindInfo(k).color }} data-ring={k === 'unused' || undefined} />}
        <span className="setup-stem-text">
          <span className="setup-stem-name">{s.name}</span>
          {unknown ? (
            <span className="setup-stem-note">{tr('名前から分からないので「その他」に', "Unknown name, so it's set to Other")}</span>
          ) : (
            <span className="setup-stem-file" title={s.file.name}>
              {s.file.name}
            </span>
          )}
        </span>
        {list && !phone && <span className="setup-role">{role}</span>}
        <KindSelect value={k} set={(v) => setPick(s, v)} label={s.name} warn={unknown} />
      </div>
    );
  };

  const drumColor = stemKindInfo('drums').color;
  const otherColor = stemKindInfo('other').color;
  const bgmName = plannedBgmName(src);
  const cards = [
    {
      k: tr('ゲームの BGM', 'Game BGM'),
      v: others.length ? tr(`ドラム以外 ${others.length} 本を合わせる`, `Mix of the ${others.length} non-drum stems`) : src.original ? tr('原曲のまま', 'The original as is') : tr('なし', 'None'),
      f: others.length ? bgmName : tr('ドラム以外のステムがありません', 'No stems other than drums'),
    },
    {
      k: tr('試聴', 'Preview'),
      v: o.preview ? (src.original ? tr('原曲のサビ', 'Chorus of the original') : tr(`${used.length} 本を合わせた音のサビ`, `Chorus of the ${used.length} stems mixed`)) : tr('作りません', 'Not made'),
      f: o.preview ? 'preview_chorus.ogg' : tr('やることで外しています', 'Left out below'),
    },
    {
      k: tr('打点・スペクトル・テンポ', 'Hits, spectrum and tempo'),
      v:
        drums.length >= 2
          ? tr(`ドラム ${drums.length} 本を合わせた音`, `The ${drums.length} drum stems mixed`)
          : drums.length === 1
            ? tr(`ドラム（${drums[0].name}）`, `Drums (${drums[0].name})`)
            : src.original
              ? tr('原曲', 'The original')
              : tr('ステムを合わせた音', 'The stems mixed'),
      f: tr('作業ファイルだけ（ゲームには入れません）', 'Work file only (not in the game)'),
    },
    ...(list
      ? []
      : [
          {
            k: tr('エディタの下のトラック', 'Tracks under the editor'),
            v: tr(`${used.length} 本を 1 本ずつ`, `${used.length} stems, one track each`),
            f: tr('1 本ずつ鳴らし分けられます', 'Each can be played on its own'),
          },
        ]),
  ];
  const chips = (
    [
      ['info', tr('曲名・アーティスト・画像', 'Title, artist and images')],
      ['tempo', tr('テンポと曲の頭', 'Tempo and song start')],
      ['preview', tr('試聴（サビ）', 'Preview (chorus)')],
      ['drums', tr('ドラムの打点', 'Drum hits')],
    ] as const
  ).map(([k, label]) => (
    <label key={k} className="setup-chip" title={k === 'info' ? infoTexts(ai).time : undefined}>
      <input type="checkbox" checked={o[k]} onChange={(e) => put(k)(e.target.checked)} />
      {label}
    </label>
  ));

  return (
    <>
      {phone && <Grip />}
      <Head
        sub={
          list
            ? tr(`選んだ ${all.length} 本はステムなので、ステム分解は飛ばします。名前から種類を見分けました。`, `The ${all.length} files are stems, so stem separation is skipped. The types come from the names.`)
            : tr(
                '分けてあるステムから始めます。ステム分解は飛ばし、名前から種類を見分けて、BGM と試聴を合わせて作ります。',
                'Starts from stems that are already split. Stem separation is skipped: the types come from the names, and the BGM and preview are mixed from them.',
              )
        }
        done={done}
      />
      <PhoneBody phone={phone}>
        <div className="setup-file">
          <span className="setup-file-icon">{Icon.wave(20)}</span>
          <span className="setup-file-text">
            {src.original ? (
              <>
                <span className="setup-file-name ellipsis">{tr(`原曲：${src.original.name}`, `Original: ${src.original.name}`)}</span>
                <span className="setup-file-meta">
                  {tr('一緒に入れた原曲をそのまま使います', 'Uses the original you added with the stems as is')}
                  {sec > 0 ? ` · ${lengthText(sec)}` : ''}
                </span>
              </>
            ) : (
              <>
                <span className="setup-file-name">{tr(`原曲：${used.length} 本を合わせて作ります`, `Original: mixed from the ${used.length} stems`)}</span>
                <span className="setup-file-meta">
                  {tr('原曲のファイルも一緒に選ぶと、そちらを使います', 'If you choose the original file too, that is used instead')}
                  {sec > 0 ? ` · ${lengthText(sec)}` : ''}
                </span>
              </>
            )}
            {src.movie && <span className="setup-file-meta">{tr(`${src.movie.name} は背景動画に`, `${src.movie.name} becomes the background movie`)}</span>}
          </span>
          {!list && <span className="lbl">{tr(`ステム ${all.length} 本`, `${all.length} stems`)}</span>}
        </div>

        {list ? (
          <div className="setup-stem-list">{all.map(row)}</div>
        ) : (
          <div className="setup-stem-cols">
            <div className="setup-stem-col">
              <div className="setup-col-h">
                <span className="setup-col-dot" style={{ background: drumColor }} />
                <b>{tr(`ドラム ${drums.length} 本`, `Drums: ${drums.length}`)}</b>
                <span>{drums.length >= 2 ? tr('合わせて 1 本のドラムとして、打点・スペクトル・テンポに', 'Mixed as one drum track for the hits, spectrum and tempo') : tr('打点・スペクトル・テンポに', 'For the hits, spectrum and tempo')}</span>
              </div>
              {drums.map(row)}
              {drums.length === 0 && <div className="setup-stem-empty">{tr('ドラムのステムがありません（打点とテンポは原曲から）', 'No drum stems (the hits and tempo come from the original)')}</div>}
              {unused.length > 0 && (
                <>
                  <div className="setup-col-h gap">
                    <span className="setup-col-dot" data-ring />
                    <b>{tr(`使わない ${unused.length} 本`, `Not used: ${unused.length}`)}</b>
                    <span>{tr('BGM にも試聴にも混ぜません', 'Not mixed into the BGM or the preview')}</span>
                  </div>
                  {unused.map(row)}
                </>
              )}
            </div>
            <div className="setup-stem-col">
              <div className="setup-col-h">
                <span className="setup-col-dot" style={{ background: otherColor }} />
                <b>{tr(`ドラム以外 ${others.length} 本`, `Other than drums: ${others.length}`)}</b>
                <span>{tr('合わせてゲームの BGM（ドラム抜き）に', 'Mixed into the game BGM (no drums)')}</span>
              </div>
              {others.map(row)}
              {others.length === 0 && <div className="setup-stem-empty">{tr('ドラム以外のステムがありません', 'No stems other than drums')}</div>}
            </div>
          </div>
        )}

        {!phone && (
          <div className="setup-cards" data-n={cards.length}>
            {cards.map((c) => (
              <div key={c.k} className="setup-card">
                <span className="setup-card-k">{c.k}</span>
                <b>{c.v}</b>
                {!list && <span className="setup-card-f">{c.f}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="setup-chips">
          {!list && <b>{tr('やること', 'What it does')}</b>}
          {chips}
          <label className="setup-chip-diff">
            {tr('難易度', 'Difficulty')}
            <DiffSelect value={o.difficulty} set={(d) => setO((x) => ({ ...x, difficulty: d }))} />
            {tr('から', 'first')}
          </label>
        </div>
        {IS_IOS && (
          <p className="setup-pwarn">
            {Icon.info(14)}
            <span>{keepOnText()}</span>
          </p>
        )}
      </PhoneBody>

      <Foot
        note={tr(`${o.difficulty} の譜面を作ります。ステム分解が無いので、30 秒ほどでエディタが開きます`, `Makes the ${o.difficulty} chart. No stem separation, so the editor opens in about 30 seconds`)}
        phone={phone}
        disabled={used.length === 0}
        onManual={manual}
        onGo={go}
      />
    </>
  );
}
