/** Fresh empty UI fields for initial render and form reset; never saved credentials. */
export function emptyFormFields(...names) {
  return Object.fromEntries(names.map((name) => [name, '']));
}
