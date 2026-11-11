// 画面左上のロゴ。アプリのアイコンの小さい版（public/icons/mark.svg。絵は scripts/icon-art.mjs、作り直しは scripts/make-pwa-images.mjs）
export function LogoMark() {
  return <img className="logo-mark" src={`${import.meta.env.BASE_URL}icons/mark.svg`} alt="" draggable={false} />;
}
