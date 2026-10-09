import {
  transliterateUmlauts,
  normalizePlaceName,
} from '@/services/routing/geocode';

// Official German umlaut transliteration (DIN 5007-2): ä→ae, ö→oe, ü→ue, ß→ss.

describe('transliterateUmlauts', () => {
  it('substitutes lowercase umlauts + ß', () => {
    expect(transliterateUmlauts('Schöneberg')).toBe('Schoeneberg');
    expect(transliterateUmlauts('Köpenick')).toBe('Koepenick');
    expect(transliterateUmlauts('Straße')).toBe('Strasse');
    expect(transliterateUmlauts('Müllerstraße')).toBe('Muellerstrasse');
  });

  it('substitutes leading capital umlauts in title case', () => {
    expect(transliterateUmlauts('Örtlich')).toBe('Oertlich');
    expect(transliterateUmlauts('Über')).toBe('Ueber');
  });

  it('leaves names without umlauts unchanged', () => {
    expect(transliterateUmlauts('Wilmersdorf')).toBe('Wilmersdorf');
    expect(transliterateUmlauts('Charlottenburg')).toBe('Charlottenburg');
  });
});

describe('normalizePlaceName', () => {
  it('strips administrative prefixes then transliterates', () => {
    expect(normalizePlaceName('Berlin-Schöneberg')).toBe('Schoeneberg');
    expect(normalizePlaceName('Bezirk Neukölln')).toBe('Neukoelln');
    expect(normalizePlaceName('Ortsteil Wilmersdorf')).toBe('Wilmersdorf');
  });

  it('leaves a bare name (no prefix) intact aside from transliteration', () => {
    expect(normalizePlaceName('Prenzlauer Berg')).toBe('Prenzlauer Berg');
    expect(normalizePlaceName('Kopenick')).toBe('Kopenick'); // OSM-stored w/o umlaut
  });
});
