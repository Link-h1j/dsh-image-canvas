// resolve 钩子（跑在 loader 线程，用 stderr 回传）
let n = 0;
let bare = 0;

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('node:') && !specifier.startsWith('data:')) {
    n++;
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      bare++;
      console.error('BARE_SPECIFIER ' + specifier + ' <- ' + (context.parentURL || '?'));
    } else {
      console.error('REL ' + specifier);
    }
  }
  return nextResolve(specifier, context);
}
