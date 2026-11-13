// 曲情報の案（タグ・iTunes・AI）をまとめて譜面に入れる。曲情報の画面の「まとめて設定」と、おまかせで準備が使う。
import { tr, pl } from '../i18n';
import type { ArtCandidate } from '../ai/songInfo';
import { setField } from '../edit/ops';
import { useEditor } from '../store/editor';
import { setYoutube, useSidecar } from '../store/sidecar';
import type { InfoField, LookupResult } from '../store/songinfo';
import { editSong, type SongEdit } from '../store/songSync';
import { artPreset, writeArtCentered } from '../ui/artExport';
import { youtubeId } from '../ui/youtube';

export const INFO_FIELDS: InfoField[] = ['TITLE', 'ARTIST', 'GENRE', 'COMMENT', 'PANEL'];

/** 何を入れるか。fields：曲名などの欄、youtube：参照映像、jacket：ジャケット（#PREIMAGE）、bg：背景（#STAGEFILE・#BACKGROUND） */
export interface InfoPick {
  fields: boolean;
  youtube: boolean;
  jacket: boolean;
  bg: boolean;
}

/** 案のうち、今の譜面と違う欄 */
export function infoChanges(result: LookupResult, fields: Record<string, string> = useEditor.getState().doc.fields): InfoField[] {
  return INFO_FIELDS.filter((k) => {
    const v = result.fields[k]?.value;
    return !!v && v.trim() !== (fields[k] ?? '').trim();
  });
}

/** 参照映像にできる公式の YouTube（今のと同じなら null） */
export function newYoutube(result: LookupResult): LookupResult['youtube'][number] | null {
  const first = result.youtube[0] ?? null;
  const yt = useSidecar.getState().youtube;
  return first && (yt ? youtubeId(yt.url) : null) !== first.id ? first : null;
}

/** 空いている所だけ入れるときの初め（ジャケットと背景は、もう入っていれば入れない） */
export function defaultInfoPick(fields: Record<string, string> = useEditor.getState().doc.fields): InfoPick {
  return { fields: true, youtube: true, jacket: !fields['PREIMAGE'], bg: !fields['BACKGROUND'] && !fields['STAGEFILE'] };
}

export interface InfoApplied {
  /** 入れた物（「3項目」「参照映像」「#PREIMAGE」…） */
  done: string[];
  /** 入れられなかった物と理由 */
  failed: string[];
  /** 譜面の変更（曲名・画像のファイル名。無ければ null） */
  edit: SongEdit | null;
}

/**
 * 曲情報の案をまとめて入れる。画像は曲フォルダに書き出してからファイル名を入れる。
 * 譜面に入れる値は 1 つの変更にまとめ（Ctrl+Z で一度に戻る）、曲のものなので同じだったほかの難易度にも入れる
 */
export async function applySongInfo(result: LookupResult, pick: InfoPick): Promise<InfoApplied> {
  const done: string[] = [];
  const failed: string[] = [];
  const put: Record<string, string> = {};
  const changes = infoChanges(result);
  if (pick.fields && changes.length) {
    for (const k of changes) put[k] = result.fields[k]!.value.trim();
    done.push(tr(`${changes.length}項目`, `${changes.length} ${pl(changes.length, 'field')}`));
  }
  const yt = newYoutube(result);
  if (pick.youtube && yt) {
    setYoutube({ url: yt.url, offset: useSidecar.getState().youtube?.offset ?? 0 });
    done.push(tr('参照映像', 'reference video'));
  }
  if (pick.jacket && result.jacket) {
    try {
      put.PREIMAGE = (await writeArtCentered(result.jacket, artPreset('pre-sq'))).name;
      done.push('#PREIMAGE');
    } catch (e) {
      failed.push(tr(`ジャケット（${(e as Error).message}）`, `cover art (${(e as Error).message})`));
    }
  }
  const first = result.youtube[0] ?? null;
  if (pick.bg && first) {
    const cand: ArtCandidate = { url: `https://i.ytimg.com/vi/${first.id}/hqdefault.jpg`, big: `https://i.ytimg.com/vi/${first.id}/maxresdefault.jpg`, label: '', source: 'youtube' };
    for (const id of ['stage', 'bg']) {
      try {
        put[artPreset(id).key] = (await writeArtCentered(cand, artPreset(id))).name;
        done.push(`#${artPreset(id).key}`);
      } catch (e) {
        failed.push(tr(`${artPreset(id).key}（${(e as Error).message}）`, `${artPreset(id).key} (${(e as Error).message})`));
        break;
      }
    }
  }
  const keys = Object.keys(put);
  const edit = keys.length
    ? editSong(tr('曲情報をまとめて設定', 'Set song info in bulk'), (d) => {
        for (const k of keys) setField(d, k, put[k]);
      })
    : null;
  return { done, failed, edit };
}
