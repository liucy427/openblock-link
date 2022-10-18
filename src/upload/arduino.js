const fs = require('fs');
const {spawn, spawnSync} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const yaml = require('js-yaml');
const os = require('os');

const AVRDUDE_STDOUT_GREEN_START = /Reading \||Writing \|/g;
const AVRDUDE_STDOUT_GREEN_END = /%/g;
const AVRDUDE_STDOUT_WHITE = /avrdude done/g;
const AVRDUDE_STDOUT_RED_START = /can't open device|programmer is not responding/g;
const AVRDUDE_STDERR_RED_IGNORE = /Executable segment sizes/g;

class Arduino {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._projectfilePath = path.join(userDataPath, 'arduino/project');
        this._arduinoPath = path.join(toolsPath, 'Arduino');
        this._sendstd = sendstd;

        this._arduinoCliPath = path.join(this._arduinoPath, 'arduino-cli');

        this._codefilePath = path.join(this._projectfilePath, 'project.ino');
        this._buildPath = path.join(this._projectfilePath, 'build');

        this.initArduinoCli();

        // If the fqbn is an object means the value of this parameter is
        // different under different systems.
        if (typeof this._config.fqbn === 'object') {
            this._config.fqbn = this._config.fqbn[os.platform()];
        }
    }

    initArduinoCli () {
        // try to init the arduino cli config.
        spawnSync(this._arduinoCliPath, ['config', 'init']);

        // if arduino cli config haven be init, set it to link arduino path.
        const buf = spawnSync(this._arduinoCliPath, ['config', 'dump']);
        const stdout = yaml.load(buf.stdout.toString());

        if (stdout.directories.data !== this._arduinoPath) {
            this._sendstd(`${ansi.yellow_dark}arduino cli config has not been initialized yet.\n`);
            this._sendstd(`${ansi.green_dark}set the path to ${this._arduinoPath}.\n`);
            spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.data', this._arduinoPath]);
            spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.downloads',
                path.join(this._arduinoPath, 'staging')]);
            spawnSync(this._arduinoCliPath, ['config', 'set', 'directories.user', this._arduinoPath]);
        }
    }

    build (code, library = []) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this._projectfilePath)) {
                fs.mkdirSync(this._projectfilePath, {recursive: true});
            }

            try {
                fs.writeFileSync(this._codefilePath, code);
            } catch (err) {
                return reject(err);
            }

            const args = [
                'compile',
                '--fqbn', this._config.fqbn,
                '--libraries', path.join(this._arduinoPath, 'libraries'),
                '--warnings=none',
                '--verbose',
                this._projectfilePath
            ];

            // if extensions library to not empty
            library.forEach(lib => {
                if (fs.existsSync(lib)) {
                    args.splice(5, 0, '--libraries', lib);
                }
            });

            const arduinoBuilder = spawn(this._arduinoCliPath, args);

            arduinoBuilder.stderr.on('data', buf => {
                const data = buf.toString();

                if (data.search(AVRDUDE_STDERR_RED_IGNORE) !== -1) { // eslint-disable-line no-negated-condition
                    this._sendstd(data);
                } else {
                    this._sendstd(ansi.red + data);
                }
            });

            arduinoBuilder.stdout.on('data', buf => {
                const data = buf.toString();
                let ansiColor = null;

                if (data.search(/Sketch uses|Global variables/g) === -1) {
                    ansiColor = ansi.clear;
                } else {
                    ansiColor = ansi.green_dark;
                }
                this._sendstd(ansiColor + data);
            });

            arduinoBuilder.on('exit', outCode => {
                this._sendstd(`${ansi.clear}\r\n`); // End ansi color setting
                switch (outCode) {
                case 0:
                    return resolve('Success');
                case 1:
                    return reject(new Error('Build failed'));
                case 2:
                    return reject(new Error('Sketch not found'));
                case 3:
                    return reject(new Error('Invalid (argument for) commandline optiond'));
                case 4:
                    return reject(new Error('Preference passed to --get-pref does not exist'));
                default:
                    return reject(new Error('Unknown error'));
                }
            });
        });
    }

    _insertStr (soure, start, newStr) {
        return soure.slice(0, start) + newStr + soure.slice(start);
    }

    async flash (firmwarePath = null) {
        const args = [
            'upload',
            '--fqbn', this._config.fqbn,
            '--verbose',
            '--verify',
            `-p${this._peripheralPath}`
        ];

        // for k210 we must specify the programmer used as kflash
        if (this._config.fqbn.startsWith('Maixduino:k210:')) {
            args.push('-Pkflash');
        }

        if (firmwarePath) {
            args.push('--input-file', firmwarePath, firmwarePath);
        } else {
            args.push(this._projectfilePath);
        }

        return new Promise((resolve, reject) => {
            const avrdude = spawn(this._arduinoCliPath, args);

            avrdude.stderr.on('data', buf => {
                let data = buf.toString();

                // todo: Because the feacture of avrdude sends STD information intermittently.
                // There should be a better way to handle these mesaage.
                if (data.search(AVRDUDE_STDOUT_GREEN_START) !== -1) {
                    data = this._insertStr(data, data.search(AVRDUDE_STDOUT_GREEN_START), ansi.green_dark);
                }
                if (data.search(AVRDUDE_STDOUT_GREEN_END) !== -1) {
                    data = this._insertStr(data, data.search(AVRDUDE_STDOUT_GREEN_END) + 1, ansi.clear);
                }
                if (data.search(AVRDUDE_STDOUT_WHITE) !== -1) {
                    data = this._insertStr(data, data.search(AVRDUDE_STDOUT_WHITE), ansi.clear);
                }
                if (data.search(AVRDUDE_STDOUT_RED_START) !== -1) {
                    data = this._insertStr(data, data.search(AVRDUDE_STDOUT_RED_START), ansi.red);
                }
                this._sendstd(data);
            });

            avrdude.stdout.on('data', buf => {
                // It seems that avrdude didn't use stdout.
                const data = buf.toString();
                this._sendstd(data);
            });

            avrdude.on('exit', code => {
                switch (code) {
                case 0:
                    if (this._config.fqbn === 'arduino:avr:leonardo' ||
                        this._config.fqbn === 'SparkFun:avr:makeymakey' ||
                        this._config.fqbn.indexOf('rp2040:rp2040') !== -1) {
                        // Waiting for usb rerecognize.
                        const wait = ms => new Promise(relv => setTimeout(relv, ms));
                        // Darwin and linux will take more time to rerecognize device.
                        if (os.platform() === 'darwin' || os.platform() === 'linux') {
                            wait(3000).then(() => resolve('Success'));
                        } else {
                            wait(1000).then(() => resolve('Success'));
                        }
                    } else {
                        return resolve('Success');
                    }
                    break;
                case 1:
                    return reject(new Error('avrdude failed to flash'));
                }
            });
        });
    }

    flashRealtimeFirmware () {
        const firmwarePath = path.join(this._arduinoPath, '../../firmwares/arduino', this._config.firmware);
        return this.flash(firmwarePath);
    }
}

module.exports = Arduino;
