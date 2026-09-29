export interface MachinePlacement {
  id: number;
  x: number;
  y: number;
  zone: 'A' | 'B' | 'C';
}

export const machinePositions: MachinePlacement[] = [
  { id: 1, x: 520, y: 260, zone: 'A' },
  { id: 2, x: 720, y: 260, zone: 'A' },
  { id: 3, x: 920, y: 260, zone: 'A' },
  { id: 4, x: 520, y: 420, zone: 'A' },
  { id: 5, x: 720, y: 420, zone: 'A' },
  { id: 6, x: 920, y: 420, zone: 'A' },

  { id: 7, x: 1160, y: 260, zone: 'B' },
  { id: 8, x: 1360, y: 260, zone: 'B' },
  { id: 9, x: 1560, y: 260, zone: 'B' },
  { id: 10, x: 1160, y: 420, zone: 'B' },
  { id: 11, x: 1360, y: 420, zone: 'B' },
  { id: 12, x: 1560, y: 420, zone: 'B' },

  { id: 13, x: 720, y: 730, zone: 'C' },
  { id: 14, x: 920, y: 730, zone: 'C' },
  { id: 15, x: 1120, y: 730, zone: 'C' },
  { id: 16, x: 720, y: 890, zone: 'C' },
  { id: 17, x: 920, y: 890, zone: 'C' },
  { id: 18, x: 1120, y: 890, zone: 'C' },
];
