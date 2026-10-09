import { BleClient } from '@capacitor-community/bluetooth-le';
import {
  createNativeBluetoothTransport,
  mapNativeError,
} from '@/lib/ble/nativeBluetooth';
import { BleCancelledError, BlePermissionError } from '@/lib/ble/transport';

// The native BleTransport (MZY-279) against a mocked
// @capacitor-community/bluetooth-le: 128-bit UUIDs, the plugin's string
// rejections → typed errors, and only unrequested drops reported.

jest.mock('@capacitor-community/bluetooth-le', () => ({
  BleClient: {
    initialize: jest.fn(async () => {}),
    isEnabled: jest.fn(async () => true),
    requestDevice: jest.fn(),
    connect: jest.fn(async () => {}),
    startNotifications: jest.fn(async () => {}),
    stopNotifications: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    openAppSettings: jest.fn(async () => {}),
  },
}));
const ble = jest.mocked(BleClient);
const STRAP = { id: 'C4:7F:51:00:00:01', name: 'HRM200' };

beforeEach(() => jest.clearAllMocks());

describe('nativeBluetooth transport', () => {
  it('scans for the 128-bit service UUID and returns the native address as the id', async () => {
    ble.requestDevice.mockResolvedValue({ deviceId: STRAP.id, name: 'HRM200' });
    const transport = createNativeBluetoothTransport();
    await expect(transport.requestDevice('heart_rate')).resolves.toEqual(STRAP);
    expect(ble.initialize).toHaveBeenCalledWith({
      androidNeverForLocation: true,
    });
    expect(ble.requestDevice).toHaveBeenCalledWith({
      services: ['0000180d-0000-1000-8000-00805f9b34fb'],
    });
  });

  it('initializes once after success, but asks again after a denied permission', async () => {
    ble.requestDevice.mockResolvedValue({ deviceId: STRAP.id });
    ble.initialize.mockRejectedValueOnce(new Error('Permission denied.'));
    const transport = createNativeBluetoothTransport();
    await expect(transport.requestDevice('csc')).rejects.toBeInstanceOf(
      BlePermissionError,
    );
    await transport.requestDevice('csc');
    await transport.requestDevice('csc');
    expect(ble.initialize).toHaveBeenCalledTimes(2);
  });

  it('refuses to scan with Bluetooth off', async () => {
    ble.isEnabled.mockResolvedValueOnce(false);
    await expect(
      createNativeBluetoothTransport().requestDevice('csc'),
    ).rejects.toThrow(/Bluetooth is off/);
    expect(ble.requestDevice).not.toHaveBeenCalled();
  });

  it('maps the plugin rejections to typed errors', () => {
    expect(
      mapNativeError(new Error('requestDevice cancelled.')),
    ).toBeInstanceOf(BleCancelledError);
    expect(mapNativeError(new Error('Permission denied.'))).toBeInstanceOf(
      BlePermissionError,
    );
    expect(mapNativeError('Connection timeout').message).toBe(
      'Connection timeout',
    );
  });

  it('subscribes to the Measurement characteristic and unsubscribes', async () => {
    const transport = createNativeBluetoothTransport();
    const unsubscribe = await transport.subscribe(STRAP, 'csc', () => {});
    const args = [
      '00001816-0000-1000-8000-00805f9b34fb',
      '00002a5b-0000-1000-8000-00805f9b34fb',
    ];
    expect(ble.startNotifications).toHaveBeenCalledWith(
      STRAP.id,
      ...args,
      expect.any(Function),
    );
    await unsubscribe();
    expect(ble.stopNotifications).toHaveBeenCalledWith(STRAP.id, ...args);
  });

  it('reports a link drop, but not its own disconnect()', async () => {
    let pluginDrop: (id: string) => void = () => {};
    ble.connect.mockImplementation(async (_id, cb) => {
      pluginDrop = cb!;
    });
    const transport = createNativeBluetoothTransport();
    const onDisconnected = jest.fn();
    await transport.connect(STRAP, onDisconnected);
    pluginDrop(STRAP.id);
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await transport.disconnect(STRAP);
    pluginDrop(STRAP.id);
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await transport.connect(STRAP, onDisconnected); // a reconnect re-arms it
    pluginDrop(STRAP.id);
    expect(onDisconnected).toHaveBeenCalledTimes(2);
  });
});
