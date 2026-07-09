import {
  expandScientificNotation,
  normalizeImeiSerial,
  normalizePhone,
} from './phone';

describe('normalizePhone (Task 1.1, §4.2 — messy legacy formats)', () => {
  it("expands Excel scientific notation: '7.53848445E8' → '+255753848445'", () => {
    expect(normalizePhone('7.53848445E8')).toBe('+255753848445');
  });

  it("converts TZ local '0765447211' → '+255765447211'", () => {
    expect(normalizePhone('0765447211')).toBe('+255765447211');
  });

  it("keeps '+255765447211' canonical", () => {
    expect(normalizePhone('+255765447211')).toBe('+255765447211');
  });

  it("handles '255 765 447211' (international without plus)", () => {
    expect(normalizePhone('255 765 447211')).toBe('+255765447211');
  });

  it("handles spaced local '0765 447 211'", () => {
    expect(normalizePhone('0765 447 211')).toBe('+255765447211');
  });

  it('all five sample forms of the same number collapse to ONE canonical form', () => {
    const forms = [
      '0765447211',
      '+255765447211',
      '255 765 447211',
      '0765 447 211',
      '+255 765-447-211',
      '765447211',
    ];
    const normalized = new Set(forms.map(normalizePhone));
    expect(normalized).toEqual(new Set(['+255765447211']));
  });

  it('bare 9-digit mobile gets the +255 prefix', () => {
    expect(normalizePhone('753848445')).toBe('+255753848445');
  });

  it('strips dots/dashes/parentheses used as separators', () => {
    expect(normalizePhone('(0765) 447-211')).toBe('+255765447211');
    expect(normalizePhone('0765.447.211')).toBe('+255765447211');
  });

  it('non-TZ international numbers keep their own country code', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('junk without digits → null; empty/null/undefined → null', () => {
    expect(normalizePhone('N/A')).toBeNull();
    expect(normalizePhone('---')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('partial/unrecognized digits fall back to cleaned digits (documented)', () => {
    expect(normalizePhone('447211')).toBe('447211');
    expect(normalizePhone('ext. 4472')).toBe('4472');
  });
});

describe('expandScientificNotation', () => {
  it('expands exactly, without float precision loss', () => {
    expect(expandScientificNotation('7.53848445E8')).toBe('753848445');
    expect(expandScientificNotation('4.29260291E9')).toBe('4292602910');
    // 15-digit IMEI-scale value stays exact.
    expect(expandScientificNotation('3.51234567891234E14')).toBe(
      '351234567891234',
    );
    expect(expandScientificNotation('2.5E3')).toBe('2500');
  });

  it('rejects non-scientific and still-fractional input', () => {
    expect(expandScientificNotation('0765447211')).toBeNull();
    expect(expandScientificNotation('EVEREST')).toBeNull();
    expect(expandScientificNotation('1.234E1')).toBeNull(); // 12.34
  });
});

describe('normalizeImeiSerial', () => {
  it('expands scientific notation and cleans separators', () => {
    expect(normalizeImeiSerial('3.51234567891234E14')).toBe('351234567891234');
    expect(normalizeImeiSerial('351234 5678-91234')).toBe('351234567891234');
  });

  it('preserves alphanumeric serials, uppercased', () => {
    expect(normalizeImeiSerial('rf8n40ww1zk')).toBe('RF8N40WW1ZK');
  });

  it('empty/blank → null', () => {
    expect(normalizeImeiSerial('')).toBeNull();
    expect(normalizeImeiSerial('  ')).toBeNull();
    expect(normalizeImeiSerial(null)).toBeNull();
  });
});
