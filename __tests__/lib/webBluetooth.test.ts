import { createWebBluetoothTransport } from '@/lib/ble/webBluetooth';
import { BleCancelledError } from '@/lib/ble/transport';

// The Web Bluetooth BleTransport (MZY-275) against a stubbed navigator.bluetooth:
// picker filter + cancel mapping, notification wiring, and that only an
// unrequested link drop reaches onDisconnected.

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  startNotifications = jest.fn(async () => this);
  stopNotifications = jest.fn(async () => this);
  emit(bytes: number[]) {
    this.value = new DataView(new Uint8Array(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function fakeDevice(id: string) {
  const characteristic = new FakeCharacteristic();
  const service = { getCharacteristic: jest.fn(async () => characteristic) };
  const server = { getPrimaryService: jest.fn(async () => service) };
  const device = Object.assign(new EventTarget(), {
    id,
    name: 'HRM200',
    gatt: {
      connected: false,
      connect: jest.fn(async () => {
        device.gatt.connected = true;
        return server;
      }),
      disconnect: jest.fn(() => {
        device.gatt.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      }),
    },
  });
  return { device, server, characteristic };
}

const requestDevice = jest.fn();
beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { bluetooth: { requestDevice } },
    configurable: true,
  });
});
beforeEach(() => requestDevice.mockReset());

describe('webBluetooth transport', () => {
  it('filters the picker by the Web Bluetooth service name', async () => {
    const { device } = fakeDevice('a');
    requestDevice.mockResolvedValue(device);
    const transport = createWebBluetoothTransport();
    expect(transport.isAvailable()).toBe(true);
    await expect(transport.requestDevice('cycling_power')).resolves.toEqual({
      id: 'a',
      name: 'HRM200',
    });
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: ['cycling_power'] }],
    });
  });

  it("maps Chrome's NotFoundError (chooser dismissed) to BleCancelledError", async () => {
    const dismissed = Object.assign(new Error('User cancelled'), {
      name: 'NotFoundError',
    });
    requestDevice.mockRejectedValue(dismissed);
    await expect(
      createWebBluetoothTransport().requestDevice('heart_rate'),
    ).rejects.toBeInstanceOf(BleCancelledError);
  });

  it('delivers frames until unsubscribed', async () => {
    const { device, server, characteristic } = fakeDevice('a');
    requestDevice.mockResolvedValue(device);
    const transport = createWebBluetoothTransport();
    const ref = await transport.requestDevice('heart_rate');
    await transport.connect(ref, () => {});
    const frames: number[] = [];
    const unsubscribe = await transport.subscribe(ref, 'heart_rate', (v) =>
      frames.push(v.getUint8(1)),
    );
    expect(server.getPrimaryService).toHaveBeenCalledWith('heart_rate');
    expect(characteristic.startNotifications).toHaveBeenCalled();

    characteristic.emit([0, 120]);
    await unsubscribe();
    characteristic.emit([0, 121]);
    expect(frames).toEqual([120]);
    expect(characteristic.stopNotifications).toHaveBeenCalled();
  });

  it('reports a link drop, but not its own disconnect()', async () => {
    const { device } = fakeDevice('a');
    requestDevice.mockResolvedValue(device);
    const transport = createWebBluetoothTransport();
    const ref = await transport.requestDevice('heart_rate');
    const onDisconnected = jest.fn();
    await transport.connect(ref, onDisconnected);

    device.dispatchEvent(new Event('gattserverdisconnected')); // strap out of range
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await transport.connect(ref, onDisconnected);
    await transport.disconnect(ref);
    expect(device.gatt.disconnect).toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('registers the drop listener once when the same device is picked again', async () => {
    const { device } = fakeDevice('a');
    requestDevice.mockResolvedValue(device);
    const transport = createWebBluetoothTransport();
    await transport.requestDevice('heart_rate');
    const ref = await transport.requestDevice('heart_rate');
    const onDisconnected = jest.fn();
    await transport.connect(ref, onDisconnected);
    device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });
});
