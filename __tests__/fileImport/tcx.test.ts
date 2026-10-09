import { parseTcx } from '@/services/fileImport/tcx';

const TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase>
 <Activities>
  <Activity Sport="Running">
   <Id>2026-08-01T09:00:00Z</Id>
   <Lap StartTime="2026-08-01T09:00:00Z">
     <TotalTimeSeconds>20.0</TotalTimeSeconds>
     <DistanceMeters>60.0</DistanceMeters>
     <Track>
      <Trackpoint>
        <Time>2026-08-01T09:00:00Z</Time>
        <Position><LatitudeDegrees>52.5200</LatitudeDegrees><LongitudeDegrees>13.4050</LongitudeDegrees></Position>
        <AltitudeMeters>34.0</AltitudeMeters>
        <DistanceMeters>0</DistanceMeters>
        <HeartRateBpm><Value>120</Value></HeartRateBpm>
        <Extensions><ns3:TPX><ns3:Speed>2.90</ns3:Speed><ns3:RunCadence>168</ns3:RunCadence></ns3:TPX></Extensions>
      </Trackpoint>
      <Trackpoint>
        <Time>2026-08-01T09:00:20Z</Time>
        <Position><LatitudeDegrees>52.5210</LatitudeDegrees><LongitudeDegrees>13.4060</LongitudeDegrees></Position>
        <AltitudeMeters>36.0</AltitudeMeters>
        <DistanceMeters>60</DistanceMeters>
        <HeartRateBpm><Value>150</Value></HeartRateBpm>
        <Extensions><ns3:TPX><ns3:Speed>3.10</ns3:Speed><ns3:RunCadence>172</ns3:RunCadence></ns3:TPX></Extensions>
      </Trackpoint>
     </Track>
   </Lap>
   <Creator xsi:type="Device_t"><Name>Garmin Forerunner 255</Name></Creator>
  </Activity>
 </Activities>
</TrainingCenterDatabase>`;

describe('parseTcx', () => {
  it('reads the creator from <Creator><Name>', () => {
    expect(parseTcx(TCX).creator).toBe('Garmin Forerunner 255');
  });

  it('extracts trackpoints incl. cumulative DistanceMeters, HR value, and RunCadence', () => {
    const { points } = parseTcx(TCX);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      lat: 52.52,
      lng: 13.405,
      altitudeM: 34,
      heartrate: 120,
      cadence: 168,
      speedMps: 2.9,
      distanceM: 0,
    });
    expect(points[1]!.distanceM).toBe(60);
    expect(points[1]!.heartrate).toBe(150);
  });

  it('reads the declared start from <Id> and sums lap TotalTimeSeconds', () => {
    const { declared } = parseTcx(TCX);
    expect(declared.startTimeMs).toBe(Date.parse('2026-08-01T09:00:00Z'));
    expect(declared.totalTimeS).toBe(20);
  });
});

describe('parseTcx — power (MZY-267)', () => {
  it('reads the TPX <Watts> extension per trackpoint', () => {
    const xml = `<TrainingCenterDatabase><Activities><Activity Sport="Biking">
      <Lap StartTime="2026-08-01T09:00:00Z"><Track>
        <Trackpoint><Time>2026-08-01T09:00:00Z</Time>
          <Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Watts>212</Watts></TPX></Extensions>
        </Trackpoint>
        <Trackpoint><Time>2026-08-01T09:00:01Z</Time></Trackpoint>
      </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const { points } = parseTcx(xml);
    expect(points.map((p) => p.watts)).toEqual([212, null]);
  });
});
