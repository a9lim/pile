// annunciator.js -- grid of trip-light cells. Built from TRIP_KEYS.
//
// Each cell is a small square showing the trip name; dark when OK, red when
// tripped, with a 30-second blink on first activation.

import { TRIP_KEYS, tripLabel } from '../physics/rps.js';

export function buildAnnunciator(container) {
  container.replaceChildren();
  const cells = {};
  for (const k of TRIP_KEYS) {
    const cell = document.createElement('div');
    cell.className = 'annunciator-cell';
    cell.dataset.trip = k;
    cell.textContent = tripLabel(k);
    container.appendChild(cell);
    cells[k] = cell;
  }
  return cells;
}

export function renderAnnunciator(cells, state) {
  for (const k of TRIP_KEYS) {
    const cell = cells[k];
    const tripped = state.trips[k];
    const bypassed = state.tripBypass[k];
    let blinking = false;
    if (tripped && (state.simTime - state.tripFirstActivated[k]) < 30) {
      blinking = ((Math.floor(state.simTime * 2) % 2) === 0);
    }
    cell.classList.toggle('tripped', tripped && !bypassed);
    cell.classList.toggle('bypassed', bypassed);
    cell.classList.toggle('blink', blinking);
  }
}
