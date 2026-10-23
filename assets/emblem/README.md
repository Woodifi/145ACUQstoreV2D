# Itemora Cadet Edition emblem

`itemora-cadet-emblem.ico` is the source, as supplied by the Owner on 2026-10-23
(9 sizes, 16–256 px). The PNGs are generated from it:

```
magick "itemora-cadet-emblem.ico[2]" -strip emblem-32.png                    # browser tab
magick "itemora-cadet-emblem.ico[8]" -strip -resize 180x180 emblem-180.png   # phone home screen
magick "itemora-cadet-emblem.ico[8]" -strip emblem-256.png                   # desktop launchers
```

`index.html` links the 32 and 180 px PNGs; `build.js` (`inlineIcons`) inlines
them as data URIs, so every built copy of the cadet edition carries the emblem.
If you replace the emblem, replace the `.ico` and regenerate all three PNGs.
