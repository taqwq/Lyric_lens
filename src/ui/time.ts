/** "{when}" in the copy: a reset time as HH:MM in Japan time, "明日 HH:MM" if not today. */
export function formatWhen(until: number, now = Date.now()): string {
  const day = (t: number) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const time = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(until));
  return day(until) === day(now) ? time : `明日 ${time}`;
}

/** "{YYYY}年{M}月{D}日" in Japan time. */
export function formatDate(at: number): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(at));
}
