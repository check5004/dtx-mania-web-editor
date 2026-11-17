import { describe, expect, it } from 'vitest';
import { nxViewText, parseNxView, shelfPerPage, shelfStart } from './viewPrefs';

describe('parseNxView', () => {
  it('reads what was saved', () => {
    const text = nxViewText({ sort: 'level', box: '/DTXFiles.Rock', filter: 'missing', sel: '/a#0' });
    expect(parseNxView(text)).toEqual({ sort: 'level', box: '/DTXFiles.Rock', filter: 'missing', sel: '/a#0' });
  });

  it('keeps null (all songs, no filter)', () => {
    expect(parseNxView('{"sort":"updated","box":null,"filter":null,"sel":null}')).toEqual({ sort: 'updated', box: null, filter: null, sel: null });
  });

  it('drops values it does not know', () => {
    expect(parseNxView('{"sort":"random","box":3,"filter":"nope","sel":{}}')).toEqual({});
    expect(parseNxView('{"filter":"bgmdrums"}')).toEqual({ filter: 'bgmdrums' });
  });

  it('ignores broken text', () => {
    expect(parseNxView(null)).toEqual({});
    expect(parseNxView('')).toEqual({});
    expect(parseNxView('{')).toEqual({});
    expect(parseNxView('"text"')).toEqual({});
    expect(parseNxView('null')).toEqual({});
  });
});

describe('shelfPerPage', () => {
  it('fits as many tiles as the width allows, from 3 to 8', () => {
    expect(shelfPerPage(1046, 12)).toBe(6);
    expect(shelfPerPage(826, 12)).toBe(5);
    expect(shelfPerPage(626, 12)).toBe(3);
    expect(shelfPerPage(300, 12)).toBe(3);
    expect(shelfPerPage(3000, 12)).toBe(8);
    expect(shelfPerPage(0, 12)).toBe(6);
  });
});

describe('shelfStart', () => {
  it('keeps the place when the chosen song is on it', () => {
    expect(shelfStart(30, 6, 6, 8)).toBe(6);
  });

  it('goes to the page of the chosen song when it is out of sight', () => {
    expect(shelfStart(30, 6, 0, 14)).toBe(12);
  });

  it('keeps the place when the chosen song left the list (made its difficulties)', () => {
    expect(shelfStart(29, 6, 12, -1)).toBe(12);
  });

  it('stays inside the list', () => {
    expect(shelfStart(10, 6, 12, -1)).toBe(4);
    expect(shelfStart(4, 6, 3, -1)).toBe(0);
    expect(shelfStart(28, 6, 0, 27)).toBe(22);
  });
});
