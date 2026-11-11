// 「DTXMania の曲」の右：選んだ曲（画像・試聴・難易度とレベルと成績・空いた難易度・点検・フォルダ・エディタ・Drive）。
// 初めての読み込みの間は、読み方と読むもの・書くものを出す（NxScanInfo）。
import { tr, isJa } from '../../i18n';
import { useEffect, useState } from 'react';
import { useDriveAuth } from '../../drive/auth';
import { targetBands, type Slot } from '../../gen/targets';
import type { Difficulty } from '../../gen/simplify';
import { fixNxSetDef, makeNxSetDef, nxImageUrl, nxPreviewLoader, openNxGen, openNxSong, openNxSongInfo, setDriveSkip } from '../../nxlib/actions';
import { checkLevel, SLOT_KEYS, type LibChart, type LibCheck, type LibSong, type SlotKey } from '../../nxlib/scan';
import { useNxLib } from '../../nxlib/store';
import { addableSlots, bytesText, bpmText, canOpen, chartIn, levelText, setDefFor, SLOT_LABEL, sourceFor, topChart } from '../../nxlib/view';
import { AuditionButton, AuditionProgress } from '../Audition';
import { Icon } from '../icons';
import { SLOT_COLOR, Thumb } from './parts';

const SLOT_TO: Record<SlotKey, Slot> = { BSC: 'BASIC', ADV: 'ADVANCED', EXT: 'EXTREME', MAS: 'MASTER' };

function labelOf(c: LibChart): string {
  return c.label || (c.slot ? SLOT_LABEL[c.slot] : c.file.replace(/\.[^.]+$/, ''));
}

function list(names: readonly string[]): string {
  return names.join(tr('・', ', '));
}

/** BOX の名前（外から順に「J-POP / 2024」） */
function boxText(s: LibSong, boxes: ReadonlyMap<string, string>): string {
  return s.box.map((k) => boxes.get(k) ?? '').filter(Boolean).join(' / ');
}

export function NxDetail({ s }: { s: LibSong }) {
  const thumb = useNxLib((st) => st.thumbs[s.id]);
  const perm = useNxLib((st) => st.perm);
  const boxes = useNxLib((st) => st.boxes);
  const draft = useNxLib((st) => st.drafts[s.id]);
  const songs = useNxLib((st) => st.songs);
  const place = useNxLib((st) => st.place);
  const driveOn = useDriveAuth((a) => a.connected);
  const [big, setBig] = useState<string | null>(null);

  // 大きい画像（許可があるときだけ。無ければ小さい画像）
  useEffect(() => {
    setBig(null);
    if (perm !== 'granted' || !s.image) return;
    let url: string | null = null;
    let live = true;
    void nxImageUrl(s).then((u) => {
      if (live) setBig((url = u));
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [s.id, s.imageSig, perm]);

  const boxNames = new Map(boxes.map((b) => [b.key, b.title]));
  const add = addableSlots(s);
  const top = topChart(s);
  const extra = s.charts.filter((c) => !c.slot);
  const nonDtx = s.charts.filter((c) => !canOpen(c)).length;
  const meta = [boxText(s, boxNames) || tr('BOX の外', 'Outside any BOX'), s.bpm && `${bpmText(s.bpm)} BPM`].filter(Boolean).join(' · ');
  const files = [
    s.setDef ? 'set.def' : '',
    s.setDef || s.charts.length < 2 ? tr(`譜面 ${s.charts.length}`, `${s.charts.length} ${s.charts.length === 1 ? 'chart' : 'charts'}`) : tr(`譜面 ${s.charts.length}（set.def なし）`, `${s.charts.length} charts (no set.def)`),
    nonDtx ? tr(`.dtx でない譜面 ${nonDtx}`, `${nonDtx} non-.dtx`) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // 空いた難易度が 2 つ以上なら、まとめて AI難易度生成へ（めやすも出す）
  let callout = '';
  if (add.length >= 2 && top?.slot) {
    const known: Partial<Record<Slot, number>> = {};
    for (const c of s.charts) if (c.slot && c.head.level !== null) known[SLOT_TO[c.slot]] = c.head.level;
    const make = add.map((k) => SLOT_TO[k] as Difficulty);
    const bands = targetBands({ known, make });
    const aims = add.map((k) => bands[SLOT_TO[k] as Difficulty]?.center).filter((x): x is number => x !== undefined);
    const pulled = add.some((k) => (bands[SLOT_TO[k] as Difficulty]?.pulled ?? 0) > 0);
    const names = list(add.map((k) => SLOT_LABEL[k]));
    callout =
      tr(`${names} がありません。${labelOf(top)} から AI難易度生成で作れます`, `${names} ${add.length === 1 ? 'is' : 'are'} missing. You can make them from ${labelOf(top)} with the AI generator`) +
      (aims.length
        ? tr(`（めやす ${list(aims.map((x) => x.toFixed(1)))}${pulled ? '。難しい曲は下の難易度も高めに' : ''}）。`, ` (aims ${list(aims.map((x) => x.toFixed(1)))}${pulled ? '; a hard song keeps its lower difficulties fairly high' : ''}).`)
        : tr('。', '.'));
  }

  const rows = SLOT_KEYS.map((k) => ({ k, c: chartIn(s, k) })).filter((r) => r.c || (add.length === 1 && add.includes(r.k)));

  return (
    <div className="nx-det-in">
      <div className="nx-dh">
        <div className="nx-jk">
          {big ? <img src={big} alt="" draggable={false} /> : <Thumb s={s} url={thumb} className="nx-jk-in" />}
          {s.preview && (
            <AuditionButton
              k={`nx:${s.id}`}
              load={nxPreviewLoader(s)}
              label={tr('試聴', 'the preview')}
              className="nx-play"
              size={10}
              idleIcon={
                <>
                  {Icon.play(10)}
                  {tr('試聴', 'Preview')}
                </>
              }
            />
          )}
          <AuditionProgress k={`nx:${s.id}`} />
        </div>
        <div className="nx-dh-text">
          <span className="nx-dtitle">{s.title || tr('曲名なし', 'Untitled')}</span>
          <span className="nx-dartist">{s.artist || tr('アーティスト未設定', 'No artist')}</span>
          <span className="lbl">{meta}</span>
          <span className="lbl mono nx-files">{files}</span>
        </div>
      </div>

      <div className="nx-sec">
        <div className="nx-sec-t">
          <span>{tr('難易度', 'Difficulties')}</span>
          <span className="nx-sec-sub">{tr('レベル · あなたの成績（NX）', 'Level · your record (NX)')}</span>
        </div>
        {rows.map(({ k, c }) =>
          c ? (
            <ChartRow key={k} s={s} c={c} color={SLOT_COLOR[k]} draft={!!draft?.includes(c.file)} />
          ) : (
            <div key={k} className="nx-dr miss">
              <i className="bar" style={{ background: SLOT_COLOR[k] }} />
              <span className="lab">
                <b style={{ color: SLOT_COLOR[k] }}>{SLOT_LABEL[k]}</b>
                <span>{tr('まだありません', 'Not made yet')}</span>
              </span>
              <span className="nx-miss-t">{tr(`${sourceFor(s, k) ? labelOf(sourceFor(s, k)!) : ''} から作れます`, `Can be made from ${sourceFor(s, k) ? labelOf(sourceFor(s, k)!) : ''}`)}</span>
              <button className="btn small nx-ai" onClick={() => void openNxGen(s, k)}>
                {Icon.sparkle(11)}
                {tr('AI で作る', 'Make with AI')}
              </button>
            </div>
          ),
        )}
        {extra.map((c) => (
          <ChartRow key={c.file} s={s} c={c} color="var(--dim)" draft={!!draft?.includes(c.file)} />
        ))}
        {callout && (
          <div className="nx-callout">
            <span>{callout}</span>
            <div>
              <button className="btn small nx-ai" onClick={() => void openNxGen(s, null)}>
                {Icon.sparkle(11)}
                {tr('AI難易度生成を開く', 'Open the AI generator')}
              </button>
            </div>
          </div>
        )}
      </div>

      {s.checks.length > 0 && (
        <div className="nx-sec">
          <div className="nx-sec-t">
            <span>{tr('点検', 'Checks')}</span>
            <span className="nx-sec-sub">{tr('NX で困る所', 'Things that trouble NX')}</span>
          </div>
          {[...s.checks]
            .sort((a, b) => (checkLevel(a.kind) === checkLevel(b.kind) ? 0 : checkLevel(a.kind) === 'warn' ? -1 : 1))
            .map((c) => (
              <CheckCard key={c.kind} s={s} c={c} songs={songs} />
            ))}
        </div>
      )}

      <div className="nx-info">
        <div className="k">
          <span>{tr('フォルダ', 'Folder')}</span>
          <div className="v">
            <span className="nx-path mono">
              {[place?.name ?? '', ...s.path].map((p, i, a) => (
                <span key={i} className={i === a.length - 1 ? 'in' : ''}>
                  {p}
                  {i < a.length - 1 && <i>/</i>}
                </span>
              ))}
            </span>
            {s.doubled && (
              <span className="nx-hint">
                {tr(
                  '曲名のフォルダが二重です。NX と同じく、譜面のある内側のフォルダをこの曲として開き、保存もそこにします。',
                  'The song-name folder is doubled. Like NX, the inner folder with the charts is opened as this song, and saving goes there too.',
                )}
              </span>
            )}
          </div>
        </div>
        <div className="k">
          <span>{tr('エディタ', 'Editor')}</span>
          <div className="v">
            {draft?.length
              ? tr(`保存していない続きがあります（${list(draft)}）。開くと続きから`, `Has unsaved changes (${list(draft)}). Opening continues from them`)
              : s.edited
                ? tr('このアプリで直しました（作業ファイルあり）', 'Edited in this app (has a work file)')
                : tr('まだ開いていません（作業ファイルなし）', 'Not opened yet (no work file)')}
          </div>
        </div>
        <div className="k">
          <span>Drive</span>
          <div className="v">
            {s.drive?.state === 'linked' ? (
              <>
                {tr(`送りました（${bytesText(s.drive.bytes)}）。保存するたびに、変わったファイルだけ送ります`, `Sent (${bytesText(s.drive.bytes)}). Each save sends only the files that changed`)}
                {s.drive.noVideo && tr('。動画は送っていません', '. Videos are not sent')}
              </>
            ) : s.drive?.state === 'skip' ? (
              <>
                {tr('この曲は送りません（保存しても送りません）', "This song isn't sent (not even when saved)")}{' '}
                <button className="btn small ghost nx-inline" onClick={() => void setDriveSkip(s, false)}>
                  {tr('送るようにする', 'Send it')}
                </button>
              </>
            ) : driveOn ? (
              <>
                {tr('送っていません。保存したときに、この曲のフォルダだけ送ります', "Not sent. When you save, only this song's folder is sent")}{' '}
                <button className="btn small ghost nx-inline" onClick={() => void setDriveSkip(s, true)}>
                  {tr('この曲は送らない', "Don't send this song")}
                </button>
              </>
            ) : (
              tr('Google Drive につないでいません', 'Google Drive is not connected')
            )}
          </div>
        </div>
      </div>

      <div className="nx-acts">
        <button className="btn primary" disabled={!top || !canOpen(top)} onClick={() => void openNxSong(s)} title={tr('Enter', 'Enter')}>
          {top ? tr(`開く（${labelOf(top)}）`, `Open (${labelOf(top)})`) : tr('開く', 'Open')}
        </button>
        <button className="btn" disabled={!top || !canOpen(top)} onClick={() => void openNxSongInfo(s)}>
          {tr('曲情報', 'Song info')}
        </button>
      </div>
    </div>
  );
}

function ChartRow({ s, c, color, draft }: { s: LibSong; c: LibChart; color: string; draft: boolean }) {
  const sc = c.score;
  const rank = sc?.rank ?? null;
  return (
    <div className="nx-dr">
      <i className="bar" style={{ background: color }} />
      <span className="lab">
        <b style={{ color }}>
          {labelOf(c)}
          {c.head.ai && <span className="nx-spark" title={tr('AI難易度生成で作った譜面', 'Made by the AI generator')}>{Icon.sparkle(9)}</span>}
        </b>
        <span title={c.file}>
          {c.file}
          {draft && <span className="nx-draft-dot" title={tr('保存していない続きがあります', 'Has unsaved changes')} />}
        </span>
      </span>
      <span className="lv mono">{levelText(c.head.level)}</span>
      <span className="rec">
        {sc && sc.plays > 0 && <span className={`nx-rk ${rank && 'SSAB'.includes(rank[0]) ? rank[0] : rank ? 'C' : 'N'}`}>{rank ?? '—'}</span>}
        <span className="rec-t">
          <span className="a">{sc && sc.plays > 0 ? (sc.skill !== null ? `${sc.skill.toFixed(1)}%` : '—') : tr('まだ遊んでいません', 'Not played yet')}</span>
          <span>{sc && sc.plays > 0 ? tr(`${sc.plays} 回`, `${sc.plays} ${sc.plays === 1 ? 'play' : 'plays'}`) : ''}</span>
        </span>
      </span>
      <button
        className="btn small"
        disabled={!canOpen(c)}
        title={canOpen(c) ? c.file : tr('このエディタで開けるのは .dtx だけです', 'This editor opens .dtx charts only')}
        onClick={() => void openNxSong(s, c)}
      >
        {tr('開く', 'Open')}
      </button>
    </div>
  );
}

function CheckCard({ s, c, songs }: { s: LibSong; c: LibCheck; songs: readonly LibSong[] }) {
  const warn = checkLevel(c.kind) === 'warn';
  let title = '';
  let text = '';
  let code = '';
  let btn: { label: string; run: () => void; amber?: boolean } | null = null;
  const files = (c.files ?? []).join('\n') + ((c.n ?? 0) > (c.files?.length ?? 0) ? tr(`\nほか ${(c.n ?? 0) - (c.files?.length ?? 0)} 個`, `\nand ${(c.n ?? 0) - (c.files?.length ?? 0)} more`) : '');
  switch (c.kind) {
    case 'nosetdef':
      title = tr('set.def がありません', 'No set.def');
      text = tr(`NX では譜面ごとに別の曲として ${c.n ?? s.charts.length} つ並びます。難易度をまとめる set.def を作れます。`, `NX lists each chart as a separate song (${c.n ?? s.charts.length} entries). You can make a set.def that groups the difficulties.`);
      code = setDefFor(s.title, s.charts).trim();
      btn = { label: tr('set.def を作る', 'Make set.def'), run: () => void makeNxSetDef(s), amber: true };
      break;
    case 'setdef-missing':
      title = tr(`set.def に書いた譜面が ${c.n ?? 1} つ見つかりません`, `${c.n ?? 1} ${c.n === 1 ? 'chart' : 'charts'} listed in set.def ${c.n === 1 ? 'is' : 'are'} missing`);
      text = tr('その難易度は NX に出ません。無い行を set.def から外せます。', "NX doesn't show that difficulty. You can remove the lines from set.def.");
      code = files;
      btn = { label: tr('set.def を直す', 'Fix set.def'), run: () => void fixNxSetDef(s) };
      break;
    case 'missing':
      title = tr(`譜面が使うファイルが ${c.n ?? 1} 個見つかりません`, `${c.n ?? 1} ${c.n === 1 ? 'file' : 'files'} used by the charts ${c.n === 1 ? 'is' : 'are'} missing`);
      text = tr('その音が鳴らない・画像や動画が出ません。開いて直せます。', "Those sounds won't play and the images or movies won't show. Open the song to fix it.");
      code = files;
      btn = { label: tr('開いて直す', 'Open and fix'), run: () => void openNxSong(s) };
      break;
    case 'badname':
      title = tr(`読めない名前のファイルが ${c.n ?? 1} 個あります`, `${c.n ?? 1} ${c.n === 1 ? 'file has a name' : 'files have names'} NX can't read`);
      text = tr(
        'Shift_JIS で書けない字があるので、NX の譜面から呼べません（文字化けで名前が変わったファイルかもしれません）。開いて名前を直せます。',
        "The names have characters that Shift_JIS can't write, so NX charts can't refer to them (the names may have been garbled). Open the song to rename them.",
      );
      code = files;
      btn = { label: tr('開いて直す', 'Open and fix'), run: () => void openNxSong(s) };
      break;
    case 'dup': {
      const key = (x: LibSong) => `${x.title.normalize('NFKC').trim().toLowerCase()}\u0000${x.artist.normalize('NFKC').trim().toLowerCase()}`;
      const k = key(s);
      const others = songs.filter((x) => x.id !== s.id && key(x) === k);
      title = tr(`同じ曲がもう ${c.n ?? others.length} つあります`, `${c.n ?? others.length} more of the same song`);
      text = tr('NX の選曲画面に同じ曲が 2 回並びます。消すのはエクスプローラーで（このアプリは消しません）。', 'The same song shows twice in NX. Delete one in File Explorer (this app never deletes).');
      code = others.map((x) => x.path.join('/')).join('\n');
      break;
    }
    case 'nopreview':
      title = tr('試聴がありません', 'No preview');
      text = tr('選曲画面で鳴りません。曲情報で、原曲から試聴を作れます。', "Nothing plays on the song select screen. Make a preview from the original in Song info.");
      btn = { label: tr('曲情報を開く', 'Open Song info'), run: () => void openNxSongInfo(s) };
      break;
    case 'noimage':
      title = tr('画像がありません', 'No image');
      text = tr('選曲画面に絵が出ません。曲情報で画像を入れられます。', 'No picture shows on the song select screen. Add one in Song info.');
      btn = { label: tr('曲情報を開く', 'Open Song info'), run: () => void openNxSongInfo(s) };
      break;
    case 'nodrums':
      title = tr('ドラムの譜面がありません', 'No drum chart');
      text = tr('ギター・ベースだけの曲です。このエディタはドラム用なので、一覧に出すだけです。', 'Guitar or bass only. This editor is for drums, so it is only listed.');
      break;
  }
  const canFix = !btn || (c.kind !== 'missing' && c.kind !== 'badname' && c.kind !== 'nopreview' && c.kind !== 'noimage') || s.charts.some(canOpen);
  return (
    <div className={`nx-ck ${warn ? 'w' : ''}`}>
      <span className="ic">{warn ? Icon.warn(13) : Icon.info(13)}</span>
      <div className="body">
        <span>
          <b>{title}</b>
          {isJa() ? '' : ' '}
          {text}
        </span>
        {code && <div className="nx-code">{code}</div>}
        {btn && canFix && (
          <div>
            <button className={`btn small ${btn.amber ? 'nx-amber' : ''}`} onClick={btn.run}>
              {btn.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 初めての読み込みの間の右：読み方・見つけた形の例・読むもの／書くもの／Drive */
export function NxScanInfo() {
  const place = useNxLib((st) => st.place);
  const scan = useNxLib((st) => st.scan);
  if (!place) return null;
  const game = place.kind === 'game';
  const inside = place.dtxPath.filter((p) => !place.extra.some((x) => x.path === p));
  const steps: { st: 'ok' | 'run' | 'wait'; t: string; d: string }[] = [
    game
      ? { st: 'ok', t: tr('ゲームのフォルダ', 'Game folder'), d: tr('Config.ini か .exe があります', 'Has Config.ini or an .exe') }
      : { st: 'ok', t: tr('曲を集めたフォルダ', 'Folder of songs'), d: tr('中のフォルダを全部探します', 'Searches all folders inside') },
    ...(game ? [{ st: 'ok' as const, t: tr('Config.ini の DTXPath', 'DTXPath in Config.ini'), d: tr(`${list(place.dtxPath)} の ${place.dtxPath.length} か所`, `${place.dtxPath.length} ${place.dtxPath.length === 1 ? 'place' : 'places'}: ${list(place.dtxPath)}`) }] : []),
    { st: scan ? 'run' : 'ok', t: tr(`${list(inside.length ? inside : ['.\\'])} を NX と同じ順に探す`, `Search ${list(inside.length ? inside : ['.\\'])} the way NX does`), d: tr('曲名のフォルダが二重でも読みます', 'Reads songs even when the song-name folder is doubled') },
    ...place.extra.map((x) => ({ st: x.dir ? ('ok' as const) : ('wait' as const), t: x.path, d: x.dir ? tr('選んだフォルダも探します', 'The chosen folder is searched too') : tr('フォルダを選ぶと続けて読みます', 'Choose the folder to read it too') })),
    { st: scan ? 'run' : 'ok', t: tr('画像を小さくして控える', 'Keep small images'), d: tr('#PREIMAGE（無ければ #STAGEFILE）', '#PREIMAGE (or #STAGEFILE)') },
  ];
  // 見つけた形の例（決まりの説明。架空の名前） i18n-ignore
  const tree: { pad: number; n: string; c: string; cls: string }[] = [
    { pad: 0, n: 'DTXFiles/', c: '', cls: '' },
    { pad: 14, n: 'Rock/  box.def', c: tr('BOX（box.def）', 'BOX (box.def)'), cls: 'b' },
    { pad: 28, n: 'Song/', c: tr('素通り', 'passed through'), cls: '' },
    { pad: 42, n: 'Song/  set.def', c: tr('1 曲（二重でも読む）', '1 song (read even when doubled)'), cls: 's' },
    { pad: 14, n: 'DTXFiles.EDM/', c: tr('BOX「EDM」', 'BOX "EDM"'), cls: 'b' },
    { pad: 28, n: 'Track/  adv.dtx  mstr.dtx', c: tr('1 曲（set.def なし）', '1 song (no set.def)'), cls: 's' },
    { pad: 14, n: 'System/', c: tr('曲なし（スキン）', 'no songs (skin)'), cls: 'c' },
  ];
  return (
    <div className="nx-det-in">
      <div>
        <div className="nx-dtitle">{tr(`${place.name} を読んでいます`, `Reading ${place.name}`)}</div>
        <div className="lbl" style={{ marginTop: 4 }}>
          {tr('読んだ曲から一覧に並びます。止めても、読んだ所までは残ります。', 'Songs appear in the list as they are read. If you stop, what was read so far is kept.')}
        </div>
      </div>
      <div className="nx-sec">
        <div className="nx-sec-t">
          <span>{tr('読み方', 'How it reads')}</span>
        </div>
        {steps.map((x, i) => (
          <div key={i} className="nx-step">
            <span className={`st ${x.st}`}>{x.st === 'ok' ? Icon.check(10) : x.st === 'run' ? <i className="nx-spin" /> : <i className="nx-dot" />}</span>
            <span>
              <b>{x.t}</b>
              <span className="lbl">{x.d}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="nx-sec">
        <div className="nx-sec-t">
          <span>{tr('見つけた形（例）', 'What it finds (example)')}</span>
        </div>
        <div className="nx-tree mono">
          {tree.map((t, i) => (
            <span key={i} style={{ paddingLeft: t.pad }} className={t.cls}>
              {t.n}
              {t.c && <i>{`  ${t.c}`}</i>}
            </span>
          ))}
        </div>
        <span className="nx-hint">
          {tr(
            'BOX（box.def・「DTXFiles.名前」）はまとまりとして、ほかのフォルダは素通りして下まで探します。曲名のフォルダが二重でも、譜面のある内側のフォルダが 1 曲です。',
            'BOXes (box.def, "DTXFiles.name") are groups; other folders are passed through all the way down. Even when the song-name folder is doubled, the inner folder with the charts is one song.',
          )}
        </span>
      </div>
      <div className="nx-info">
        <div className="k">
          <span>{tr('読むもの', 'Reads')}</span>
          <div className="v">{tr('名前と小さいファイルだけ（set.def・box.def・譜面・成績・画像）。音や動画は読みません。', 'Only names and small files (set.def, box.def, charts, records, images). No audio or video.')}</div>
        </div>
        <div className="k">
          <span>{tr('書くもの', 'Writes')}</span>
          <div className="v">{tr('ありません。一覧と小さい画像は、このブラウザの中に控えます。', 'Nothing. The list and small images are kept in this browser.')}</div>
        </div>
        <div className="k">
          <span>Drive</span>
          <div className="v">{tr('何も送りません。', 'Nothing is sent.')}</div>
        </div>
      </div>
    </div>
  );
}
