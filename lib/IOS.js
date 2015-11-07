/**
 * @name iOS
 * @version 0.0.1
 * @fileoverview IOS specific build procedures
 */

var corciLibs = require('corci-libs');
var Common = corciLibs.Common;
var async = Common.async;
var multiGlob = Common.multiGlob;
var fs = Common.fsExtra;
var path = require('path');
var Msg = corciLibs.Msg;

var exec = require('child_process').exec;
var splice = Array.prototype.splice;
var maxBuffer = 524288;

/**
 * Constructor of the ios build sequence
 *
 * @class
 * @param {Build} build - reference to the build object
 * @param {Agent} agent - reference to the agent
 */
function IOS(build, agent) {
    this.build = build;
    this.agent = agent;
    this.workFolder = build.locationPath;
    this.buildDir = path.resolve(this.workFolder, 'platforms/ios/build/device/'); //@TODO: device = variable?
    this.payloadDir = null;
    this.itunesartwork = null;
    this.appDir = null;
    this.productName = null;
}

/**
 * report to the agent if something goes wrong
 */
IOS.prototype.buildFailed = function () {
    splice.call(arguments, 0, 0, this.build);
    return this.agent.buildFailed.apply(this.agent, arguments);
};

/**
 * Hook into filesDone to do some file manipulation
 *
 * @param {function} startBuild - the Agent's callback to start the build
 */
IOS.prototype.filesDone = function (startBuild) {
    this.agent.callback = startBuild;
    if (this.build.conf.status === 'cancelled') {
        return;
    }

    /* Replace build.xcconfig to disable Code-Signing */
    if (this.build.conf.iosskipsign) {
        var xcconfig = path.resolve(this.workFolder, 'platforms', 'ios', 'cordova', 'build.xcconfig');
        try {
            fs.writeFileSync(xcconfig, 'CODE_SIGN_IDENTITY=\nCODE_SIGNING_REQUIRED=NO\nPROVISIONING_PROFILE=');
        } catch (e) {
            this.agent.log(this.build, Msg.error, 'Error: Can\'t replace build.xcconfig at {2}', path.resolve(xcconfig, '..'));
            if (e) {
                this.agent.log(this.build, Msg.error, e);
            }
        }
    }
    this.setPermissions.apply(this);
};

/**
 * Set permission of cordova-platform files to 777
 */
IOS.prototype.setPermissions = function () {
    var globs = path.resolve(this.workFolder, 'platforms/ios/cordova/**/*');
    multiGlob(globs, function (err, files) {
        if (err) {
            return this.agent.callback(err);
        }

        async.each(files, function (file, cb) {
            fs.chmod(file, 777, function (err) {
                cb.defer(0, null, err);
            });
        }, function (err) {
            this.agent.callback.defer(0, this.agent, err);
        }.bind(this));
    }.bind(this));
};

/**
 * Hook into buildDone to sign the app and / or generate the .ipa-file
 *
 * @param {Object} [err] - error object or null
 */
IOS.prototype.buildDone = function (err) {
    if (this.build.conf.status === 'cancelled') {
        return;
    }
    if (err) {
        return this.buildFailed.call(this, err);
    }

    multiGlob(['*.app'], {
        cwd: this.buildDir
    }, function (err, files) {
        if (err) {
            this.agent.log(this.build, Msg.error, 'There was an error searching the .app directory:\n{2}', err);
        }
        if (files && files.length && files.length > 0) {
            this.agent.log(this.build, Msg.info, 'Found the following .app-file(s):\n{2}', files.join('\n'));
        } else {
            this.buildFailed('No .app-file(s) found...');
            return false;
        }

        this.appDir = path.resolve(this.buildDir, files[0]);
        this.payloadDir = path.resolve(this.buildDir, 'Payload');
        this.itunesartwork = path.resolve(this.appDir, 'iTunesArtwork');
        this.productName = path.basename(this.appDir).replace(/\.[^/.]+$/, '');
        if (fs.existsSync(this.appDir)) {
            if (this.build.conf.iosskipsign) {
                this.agent.log(this.build, Msg.info, 'Creating a new unsigned ipa!');
                this.generateUnsignedIpa.apply(this);
            } else {
                this.generateSignedIpa.apply(this);
            }
        }
    }.bind(this));
};

/**
 * generate signed IPA
 */
IOS.prototype.generateSignedIpa = function () {
    this.agent.log(this.build, Msg.info, 'Creating a new signed ipa!');

    if (!this.build.conf.iosprovisioningpath) {
        return this.buildFailed('-iosprovisioningpath:"path-to-your-provision-file.mobileprovision" was not being specified!');
    }
    if (!this.build.conf.ioscodesignidentity) {
        return this.buildFailed('-ioscodesignidentity:"your-provision-name" was not being specified!');
    }
    var IpaPath = path.resolve(this.buildDir, this.productName + '.ipa');
    var InfoPlistPath = path.resolve(this.appDir, 'Info.plist');

    if (!fs.existsSync(this.build.conf.iosprovisioningpath)) {
        return this.buildFailed('-iosprovisioningpath:"{2}" file does not exist!', this.build.conf.iosprovisioningpath);
    }

    var xcodebuildLogPath = path.resolve(this.workFolder, 'build.ios.xcodebuild.log');
    var signLogPath = path.resolve(this.workFolder, 'build.ios.sign.xcrun.log');
    var execPath = '/usr/bin/xcrun -sdk iphoneos PackageApplication -v "{0}" -o "{1}" --sign "{2}" --embed "{3}" | tee "{4}" | egrep -A 5 -i "(return|sign|invalid|error|warning|succeeded|fail|running)"'.format(this.appDir, IpaPath, this.build.conf.ioscodesignidentity, this.build.conf.iosprovisioningpath, signLogPath);

    this.agent.log(this.build, Msg.status, 'executing: {2}', execPath);

    this.agent.exec(this.build, execPath, {maxBuffer: maxBuffer}, function (err, stdout, stderr) {
        if (this.build.conf.status === 'cancelled') {
            return;
        }
        if (stdout) {
            this.agent.log(this.build, Msg.buildLog, '{2}', stdout);
        }
        if (err) {
            this.agent.log(this.build, Msg.error, 'error:\n{2}', err);
        }
        if (stderr && (err && err.message || '').indexOf(stderr) < 0) {
            this.agent.log(this.build, Msg.error, 'stderror:\n{2}', stderr);
        }
        var e = stderr || err;
        if (e) {
            return this.agent.buildFailed(this.build, '');
        }
        this.agent.log(this.build, Msg.status, 'Converting Info.plist as xml: \nplutil -convert xml1 {2}', InfoPlistPath);

        this.agent.exec(this.build, 'plutil -convert xml1 ' + InfoPlistPath, {maxBuffer: maxBuffer}, function (err, stdout, stderr) {
            if (err || stderr) {
                return this.agent.buildFailed(this.build, 'plutil erro converting Info.plist as xml: \n{2}\n{3}', err, stderr);
            }
            this.agent.log(this.build, Msg.info, 'Output files: \n{2}\n{3}', IpaPath, InfoPlistPath);
            this.agent.buildSuccess(this.build, [IpaPath, InfoPlistPath, signLogPath, xcodebuildLogPath]);
        }.bind(this), 'plutil process exited with code');
    }.bind(this), 'sign process exited with code {2}');
};

/**
 * generate unsigned IPA
 */
IOS.prototype.generateUnsignedIpa = function () {
    /* 1.) create Payload directory */
    fs.mkdirs(this.payloadDir, function (err) {
        if (err) {
            this.agent.log(this.build, Msg.error, 'Can\'t create Payload directory at {2}:\n{3}', this.buildDir, err);
        }

        /* 2.) copy .app-file recursively into Payload directory */
        this.agent.log(this.build, Msg.info, 'Currently assuming that Product Name is {2}', this.productName);

        fs.copy(this.appDir, this.payloadDir, function (err) {
            if (err) {
                this.agent.log(this.build, Msg.error, 'Can\'t copy {2} to {3}:\n{4}', path.basename(this.appDir), this.payloadDir, err);
            }

            /* 3.) copy iTunesArtwork to Build Directory directory */
            fs.exists(this.itunesartwork, function (exists) {
                if (exists) {
                    fs.copy(this.itunesartwork, this.buildDir, function (err) {
                        if (err) {
                            this.agent.log(this.build, Msg.error, 'Can\'t copy {2} to {3}:\n{4}', this.itunesartwork, this.buildDir, err);
                        }
                    }.bind(this));
                }

                /* 4.) zip Payload and iTunesArtwork */
                exec('/usr/bin/zip -r {0}.ipa Payload iTunesArtwork'.format(this.productName), {
                    cwd: this.buildDir,
                    maxBuffer: maxBuffer
                }, function (err, stdout, stderr) {
                    if (this.build.conf.status === 'cancelled') {
                        return;
                    }
                    if (stdout) {
                        this.agent.log(this.build, Msg.buildLog, stdout);
                    }
                    var e;
                    if (err && (!err.code || err.code !== 1)) {
                        e = 1;
                        this.agent.log(this.build, Msg.error, 'error:\n{2}', err);
                    }
                    if (stderr && (err && err.message || err && err.indexOf && err || '').indexOf(stderr) < 0) {
                        this.agent.log(this.build, Msg.error, 'stderror:\n{2}', stderr);
                    }
                    if (e) {
                        return this.agent.buildFailed(this.build);
                    }

                    /* 5.) Return the files and finish build */
                    var IpaPath = path.resolve(this.buildDir, this.productName + '.ipa');
                    var xcodebuildLogPath = path.resolve(this.workFolder, 'build.ios.xcodebuild.log');
                    var InfoPlistPath = path.resolve(this.appDir, 'Info.plist');

                    return this.agent.buildSuccess(this.build, [IpaPath, xcodebuildLogPath, InfoPlistPath]);
                }.bind(this));
            }.bind(this));
        }.bind(this));
    }.bind(this));
};

/**
 * Hooks into {@link GenericBuild}'s onExecutingCordovaBuild
 * passes some more arguments to the cordova command
 *
 * @param {Build}    build        - the current build
 * @param {string}   cmd          - the "planned" command to execute cordova build
 * @param {function} buildCordova - the {@link Agent}'s callback
 */
IOS.prototype.preCordovaBuild = function (build, cmd, buildCordova) {
    cmd += ' | tee "' + path.resolve(this.locationPath, 'build.ios.xcodebuild.log') + '" | egrep -A 5 -i "(error|warning|succeeded|fail|codesign|running|return)"';

    if (build.conf.iosskipsign) {
        buildCordova(
            null,
            cmd,
            '--device'
        );//pass the --device argument only on ios
    } else {
        buildCordova(
            null,
            cmd,
            '--device{0}{1}'.format(
                build.conf.ioscodesignidentity && " CODE_SIGN_IDENTITY='{0}'".format(build.conf.ioscodesignidentity) || '',
                build.conf.iosprovisioningpath && " PROVISIONING_PROFILE='{0}'".format(build.conf.iosprovisioningpath) || ''
            )
        );//pass the --device argument only on ios
    }
};

module.exports = IOS;