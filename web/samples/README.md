# Discogs releases sample

`discogs-releases.xml` contains 7,622 complete release records.

The file is a 30 MB slice of the Discogs August 2026 releases dump.
The retrieval date is August 23, 2026.

Discogs provides the source as a monthly XML file:

<https://data.discogs.com/?download=data%2F2026%2Fdiscogs_20260801_releases.xml.gz>

Discogs makes the included release data available as CC0 data:

<https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use>

Run this command to rebuild the sample:

```sh
node scripts/build-discogs-sample.mjs 30
```

The script stops after the first complete release that reaches the selected size.
