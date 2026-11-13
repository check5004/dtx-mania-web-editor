// タブレット版の画面で共通の小物（パネルの一覧・ファイルを選ぶ・保存と書き出しの開閉）
import { create } from 'zustand';
import { tr } from '../../i18n';
import { openPickedFiles, save } from '../../app/fileActions';
import { IS_IOS, type PanelId } from '../../store/device';
import { useEditor } from '../../store/editor';
import { useLocalSongs } from '../../store/localSongs';

export interface PanelDef {
  id: PanelId;
  label: string;
  /** パネルの見出し（ボタンの名前より詳しく） */
  title: string;
}

/** 右のレール・下のシートのパネル（並びはデザインのとおり） */
export function tabletPanels(): PanelDef[] {
  return [
    { id: 'pad', label: tr('パッド', 'Pads'), title: tr('パッド', 'Pads') },
    { id: 'snd', label: tr('音', 'Sounds'), title: tr('音（キット・WAV・曲情報）', 'Sounds (kit, WAV, song info)') },
    { id: 'src', label: tr('原曲', 'Original'), title: tr('原曲と参照映像', 'Original and reference video') },
    { id: 'asst', label: tr('耳コピ', 'Assist'), title: tr('耳コピアシスト', 'Transcription assist') },
    { id: 'chk', label: tr('確かめる', 'Check'), title: tr('確かめる', 'Check') },
    { id: 'prev', label: tr('プレビュー', 'Preview'), title: tr('DTXMania風プレビュー', 'DTXMania-style preview') },
  ];
}

interface TabletUi {
  /** 保存と書き出し（横は中央のカード、縦は下からのシート） */
  saveSheet: boolean;
  /** AI難易度生成の詳細（判定・方針）の小窓 */
  genDetail: boolean;
}

export const useTabletUi = create<TabletUi>(() => ({ saveSheet: false, genDetail: false }));

export function setGenDetail(open: boolean | ((was: boolean) => boolean)) {
  useTabletUi.setState((s) => ({ genDetail: typeof open === 'function' ? open(s.genDetail) : open }));
}

export function openSaveSheet() {
  useTabletUi.setState({ saveSheet: true });
}

export function closeSaveSheet() {
  useTabletUi.setState({ saveSheet: false });
}

/**
 * タブレットの保存：曲フォルダ（PC で選んだフォルダ・本体）に直接書けるならいつもどおり保存する
 * （iPad はフォルダを選べないので、本体に曲フォルダごと保存する）。本体も使えなければ「保存と書き出し」を開く
 */
export function tabletSave() {
  if (useEditor.getState().folder?.dir || useLocalSongs.getState().ready) void save();
  else openSaveSheet();
}

/**
 * ファイルを選ぶ（ZIP・DTX・音声）。iPad の Safari はフォルダを選べないので、曲は ZIP で開く。
 * iPad は種類を絞ると .dtx が選べなくなるので、何でも選べるようにしておく
 */
export function openFilesPicker(kind: 'any' | 'zip' = 'any') {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = kind === 'any';
  if (kind === 'zip') input.accept = '.zip,application/zip';
  else if (!IS_IOS) input.accept = '.zip,.dtx,audio/*,.ogg,.wav,.mp3,.m4a,.flac,.opus,.mp4,.m4v,.mov,.webm,.mkv';
  input.style.display = 'none';
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    input.remove();
    if (files.length) void openPickedFiles(files);
  };
  document.body.appendChild(input);
  input.click();
}
