// Jam monotonik yang dapat disuntikkan ke pipeline verifier.
// Deadline dan watchdog membaca waktu lewat `Clock`, bukan `Date`, sehingga hasil tidak
// bergantung pada jam dinding dan tes dapat memajukan waktu tanpa menunggu (FakeClock).

/** `now()` mengembalikan milidetik; nilainya tidak pernah turun antara dua pembacaan. */
export interface Clock {
  now(): number;
}

/** Jam produksi: `performance.now()` bersifat monotonik dan tidak terpengaruh perubahan jam sistem. */
export function systemClock(): Clock {
  return { now: () => performance.now() };
}

/**
 * Jam untuk tes. Waktu hanya maju lewat `advance`. Selisih negatif atau bukan bilangan terhingga
 * diabaikan (tidak ada throw di batas modul), sehingga jam tetap monotonik untuk masukan apa pun.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = Number.isFinite(start) ? start : 0;
  }

  now(): number {
    return this.current;
  }

  /** Memajukan jam sebesar `ms` dan mengembalikan waktu baru. */
  advance(ms: number): number {
    if (Number.isFinite(ms) && ms > 0) this.current += ms;
    return this.current;
  }
}
