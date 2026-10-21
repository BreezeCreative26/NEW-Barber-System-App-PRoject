// "Free cancellation until" choices, shared by setup and Settings. Hours before the visit.
const CHOICES: Array<[number, string]> = [
  [0, "Any time"], [1, "1 hour before"], [2, "2 hours before"], [3, "3 hours before"], [4, "4 hours before"], [6, "6 hours before"],
  [8, "8 hours before"], [12, "12 hours before"], [18, "18 hours before"], [24, "24 hours before"], [36, "36 hours before"],
  [48, "48 hours before (2 days)"], [72, "72 hours before (3 days)"], [96, "4 days before"], [120, "5 days before"], [168, "1 week before"],
];
export function cancelOptions(current?: number) {
  const list = current != null && !CHOICES.some(([h]) => h === current) ? [...CHOICES, [current, `${current} hours before`] as [number, string]].sort((a, b) => a[0] - b[0]) : CHOICES;
  return list.map(([h, label]) => <option key={h} value={h}>{label}</option>);
}
