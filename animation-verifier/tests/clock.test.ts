// Tes jam verifier: FakeClock harus monotonik dan dapat dimajukan, systemClock tidak boleh mundur.
// Deadline dan watchdog pipeline bergantung pada dua sifat ini (Requirement 6.12, 9.x).
import { describe, expect, it } from "vitest";
import { FakeClock, systemClock } from "../src/clock.js";

describe("FakeClock", () => {
  it("mulai dari 0 dan tidak bergerak sendiri", () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("memakai waktu awal yang diberikan", () => {
    expect(new FakeClock(1500).now()).toBe(1500);
  });

  it("maju sebesar selisih dan mengembalikan waktu baru", () => {
    const clock = new FakeClock();
    expect(clock.advance(250)).toBe(250);
    expect(clock.advance(750)).toBe(1000);
    expect(clock.now()).toBe(1000);
  });

  it("menerima selisih pecahan dan nol", () => {
    const clock = new FakeClock(10);
    expect(clock.advance(0.5)).toBe(10.5);
    expect(clock.advance(0)).toBe(10.5);
  });

  it("tidak pernah mundur untuk selisih negatif atau bukan bilangan terhingga", () => {
    const clock = new FakeClock(100);
    for (const bad of [-1, -1e9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clock.advance(bad)).toBe(100);
    }
    expect(clock.now()).toBe(100);
  });

  it("pembacaan berurutan tidak menurun di antara rangkaian selisih campuran", () => {
    const clock = new FakeClock();
    const steps = [5, -3, 0, 12.5, Number.NaN, 1, -100, 7];
    let previous = clock.now();
    for (const step of steps) {
      clock.advance(step);
      const current = clock.now();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    expect(previous).toBe(25.5);
  });

  it("waktu awal yang tidak terhingga dianggap 0", () => {
    expect(new FakeClock(Number.NaN).now()).toBe(0);
    expect(new FakeClock(Number.POSITIVE_INFINITY).now()).toBe(0);
  });
});

describe("systemClock", () => {
  it("mengembalikan bilangan terhingga yang tidak menurun", () => {
    const clock = systemClock();
    let previous = clock.now();
    expect(Number.isFinite(previous)).toBe(true);
    for (let i = 0; i < 1000; i += 1) {
      const current = clock.now();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
