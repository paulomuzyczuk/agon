import { parseTcxTrackpoints } from '@/services/googleHealth/streams';

// Pure TCX-trackpoint parser — the streams path's testable core (the network
// fetch is a thin wrapper over the client). No network, no DB.

const TCX = `<?xml version="1.0"?>
<TrainingCenterDatabase>
 <Activities><Activity Sport="Running"><Lap><Track>
  <Trackpoint>
    <Time>2026-07-24T06:00:00Z</Time>
    <Position><LatitudeDegrees>52.5200</LatitudeDegrees><LongitudeDegrees>13.4050</LongitudeDegrees></Position>
    <AltitudeMeters>34.0</AltitudeMeters>
    <DistanceMeters>0</DistanceMeters>
    <HeartRateBpm><Value>120</Value></HeartRateBpm>
    <Extensions><ns3:TPX><ns3:Speed>2.90</ns3:Speed><ns3:RunCadence>168</ns3:RunCadence></ns3:TPX></Extensions>
  </Trackpoint>
  <Trackpoint>
    <Time>2026-07-24T06:00:10Z</Time>
    <Position><LatitudeDegrees>52.5203</LatitudeDegrees><LongitudeDegrees>13.4055</LongitudeDegrees></Position>
    <AltitudeMeters>34.5</AltitudeMeters>
    <DistanceMeters>29.0</DistanceMeters>
    <HeartRateBpm><Value>128</Value></HeartRateBpm>
    <Extensions><ns3:TPX><ns3:Speed>3.10</ns3:Speed><ns3:RunCadence>172</ns3:RunCadence></ns3:TPX></Extensions>
  </Trackpoint>
 </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>`;

describe('parseTcxTrackpoints', () => {
  it('extracts aligned series, rebasing time to seconds from the first point', () => {
    const { streams, startLat, startLng } = parseTcxTrackpoints(TCX);
    expect(streams).not.toBeNull();
    expect(streams!.timeS).toEqual([0, 10]);
    expect(streams!.heartrate).toEqual([120, 128]);
    expect(streams!.distanceM).toEqual([0, 29]);
    expect(streams!.altitudeM).toEqual([34, 34.5]);
    expect(streams!.cadence).toEqual([168, 172]); // RunCadence from Extensions
    expect(streams!.velocitySmoothMps).toEqual([2.9, 3.1]);
    expect(startLat).toBe(52.52);
    expect(startLng).toBe(13.405);
  });

  it('returns EMPTY for a document with no trackpoints', () => {
    const out = parseTcxTrackpoints('<TrainingCenterDatabase/>');
    expect(out.streams).toBeNull();
    expect(out.startLat).toBeNull();
    expect(out.startLng).toBeNull();
  });

  it('nulls a field on points that lack it, but keeps the array when any point has it', () => {
    const tcx = `<Track>
      <Trackpoint><Time>2026-07-24T06:00:00Z</Time><HeartRateBpm><Value>110</Value></HeartRateBpm></Trackpoint>
      <Trackpoint><Time>2026-07-24T06:00:05Z</Time></Trackpoint>
    </Track>`;
    const { streams } = parseTcxTrackpoints(tcx);
    expect(streams!.timeS).toEqual([0, 5]);
    expect(streams!.heartrate).toEqual([110, null]);
    // No point had GPS/distance → those arrays are omitted entirely.
    expect(streams!.distanceM).toBeNull();
    expect(streams!.altitudeM).toBeNull();
  });

  it('skips trackpoints missing the <Time> alignment axis', () => {
    const tcx = `<Track>
      <Trackpoint><HeartRateBpm><Value>99</Value></HeartRateBpm></Trackpoint>
      <Trackpoint><Time>2026-07-24T06:00:00Z</Time><HeartRateBpm><Value>100</Value></HeartRateBpm></Trackpoint>
    </Track>`;
    const { streams } = parseTcxTrackpoints(tcx);
    expect(streams!.timeS).toEqual([0]);
    expect(streams!.heartrate).toEqual([100]);
  });
});

describe('parseTcxTrackpoints — power (MZY-267)', () => {
  it("parses the TPX <Watts> extension as measured ('device') power", () => {
    const tcx = `<TrainingCenterDatabase>
      <Trackpoint><Time>2026-07-24T06:00:00Z</Time>
        <Extensions><ns3:TPX><ns3:Speed>8.1</ns3:Speed><ns3:Watts>187.6</ns3:Watts></ns3:TPX></Extensions>
      </Trackpoint>
      <Trackpoint><Time>2026-07-24T06:00:01Z</Time></Trackpoint>
    </TrainingCenterDatabase>`;
    const { streams } = parseTcxTrackpoints(tcx);
    expect(streams!.watts).toEqual([188, null]);
    expect(streams!.wattsSource).toBe('device');
  });

  it('leaves watts and its source null when no point carries power', () => {
    const { streams } = parseTcxTrackpoints(TCX);
    expect(streams!.watts).toBeNull();
    expect(streams!.wattsSource).toBeNull();
  });
});
