// BGA の列：自動（BGA のある曲で、入るとき。タブレットはレーンを狭めて入れる・スマホは出さない）・出す・出さない。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, type DtxDoc } from '../dtx/model';

const noop = () => undefined;
vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: noop, addEventListener: noop, removeEventListener: noop, innerWidth: 1440, innerHeight: 900 });
vi.stubGlobal('document', { addEventListener: noop, querySelector: () => null, documentElement: { classList: { toggle: noop }, style: { setProperty: noop } } });

const { useEditor } = await import('./editor');
const { useDevice } = await import('./device');
const { bgaVisible, setBgaFits, useBga } = await import('./bga');

const withBga = (): DtxDoc => ({ ...emptyDoc(), fields: { TITLE: 't', BMP01: 'jacket.png' } });

describe('BGA の列', () => {
  beforeEach(() => {
    useEditor.setState({ doc: withBga() });
    useDevice.setState({ phone: false, tablet: false });
    useBga.setState({ column: 'auto' });
    setBgaFits(true);
  });

  it('自動：BGA のある曲で、入るときだけ出す（PC）', () => {
    expect(bgaVisible()).toBe(true);
    setBgaFits(false);
    expect(bgaVisible()).toBe(false);
    useEditor.setState({ doc: emptyDoc() });
    setBgaFits(true);
    expect(bgaVisible()).toBe(false);
  });

  it('自動：タブレットは狭くても出す（レーンを狭めて入れる）、スマホは出さない', () => {
    setBgaFits(false);
    useDevice.setState({ tablet: true });
    expect(bgaVisible()).toBe(true);
    useDevice.setState({ tablet: false, phone: true });
    expect(bgaVisible()).toBe(false);
  });

  it('出す・出さないは、狭さや BGA の有無に関わらずそのとおり', () => {
    useBga.setState({ column: 'show' });
    setBgaFits(false);
    useEditor.setState({ doc: emptyDoc() });
    expect(bgaVisible()).toBe(true);
    useBga.setState({ column: 'hide' });
    useEditor.setState({ doc: withBga() });
    setBgaFits(true);
    expect(bgaVisible()).toBe(false);
  });
});
