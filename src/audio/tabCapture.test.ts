import { describe, expect, it } from 'vitest';
import { clickCluster } from './tabCapture';

describe('clickCluster', () => {
  it('そろった遅れを使い、次のクリックを拾った外れ値は捨てる', () => {
    expect(clickCluster([0.369, 0.069, 0.07, 0.069])).toEqual([0.069, 0.07, 0.069]);
  });
  it('2 つ以上そろわなければ空', () => {
    expect(clickCluster([0.07, 0.37])).toEqual([]);
    expect(clickCluster([0.07])).toEqual([]);
    expect(clickCluster([])).toEqual([]);
  });
});
