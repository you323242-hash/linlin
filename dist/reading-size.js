const readingSize = document.querySelector('#reading-size');
readingSize?.addEventListener('change', () => {
  if (['16', '18', '20'].includes(readingSize.value)) {
    document.documentElement.style.setProperty('--reading-size', `${readingSize.value}px`);
  }
});

