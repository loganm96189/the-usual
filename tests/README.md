Tests are manual for now: run `python3 -m http.server` and search a city.
To test the data pipeline without the 2.3 GB download, build a small ATP-style zip
(GeoJSON FeatureCollections or ndjson.gz inside) and run
`MIN_ROWS=1 python3 scripts/build_data.py --zip your_fixture.zip`.
