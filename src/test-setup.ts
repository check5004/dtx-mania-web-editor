// テストの前に読み込む。今までのテストは日本語の文を確かめているので、言語は日本語にしておく
// （英語の文を確かめるテストは、その中で setLang('en', false) にする）。
import { setLang } from './i18n';

setLang('ja', false);
