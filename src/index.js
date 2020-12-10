const path = require('path');
const qiniu = require("qiniu");
const glob = require('glob');
const core = require('@actions/core');

// 存储区域
const zoneConfig = {
    华东: 'Zone_z0',
    华北: 'Zone_z1',
    华南: 'Zone_z2',
    北美: 'Zone_na0',
    东南亚: 'Zone_as0',
};

class Up2Qn {
    constructor(options = {}) {
        const setting = Object.assign({
            targetDir: '/',
            localExclude: 'node_modules'
        }, options);
        // 存储配置
        this.setting = setting;

        // 生成 token 所需要的 mac
        this.mac = new qiniu.auth.digest.Mac(setting.AK, setting.SK);

        // 上传配置
        const config = new qiniu.conf.Config();
        config.zone = qiniu.zone[zoneConfig[setting.zone]];

        // 文件上传对象
        this.formUploader = new qiniu.form_up.FormUploader(config);

        // 获取要上传的文件
        this.files = glob.sync(`**/${setting.localDir}/**`, {
            nodir: true,
            ignore: this.getIgonres(setting.localExclude)
        });

        core.info(`
            ============ 配置信息 ============
            上传到空间：${setting.bucket}
            上传到存储区域：${setting.zone}
            本地文件夹：${setting.localDir}
            本地排除文件：${setting.localExclude}
            七牛云目标文件夹：${setting.targetDir}
            待上传的文件列表：${this.files.join(',')}
            ============ 上传信息 ============
        `);

        this.start();
    }

    // 开始处理
    start() {
        const self = this;
        const tasks = [];
        // 生成队列
        this.files.forEach(file => {
            const fn = () => {
                return this.upload(file);
            };
            tasks.push(fn);
        });

        // 执行异步队列
        this.asyncRun(tasks, {
            callback(res) {
                core.info(`${res.file} ${res.isOverwrite ? '覆盖' : ''}上传成功`);
            },
            errorback(err){
                if (+err.res.statusCode === 614) {
                    core.info(`${err.file} 文件已存在并且有变更，稍后尝试覆盖上传...`);

                    // 追加到末尾，待正常文件传完，再执行覆盖上传
                    tasks.push(() => {
                        return self.upload(err.file, true);
                    });
                } else {
                    core.error(`${err.file} 上传失败！`);
                    core.error(err.resBody);
                }
            }
        });
    }

    /**
     * 上传
     * @param {string} file 文件名
     * @param {boolean} isOverwrite
     */
    upload(file, isOverwrite = false) {
        const localFile = path.resolve(process.cwd(), file);
        const fileTrim = file.split(`${this.setting.localDir}/`)[1];
        let targetFile = path.join(this.setting.targetDir, fileTrim);
        targetFile = targetFile.replace(/\\/g, '/').replace(/^\//, '');
        const uploadToken = this.getToken(isOverwrite ? targetFile : false);

        return new Promise((resolve, reject) => {
            const putExtra = new qiniu.form_up.PutExtra();
            this.formUploader.putFile(uploadToken, targetFile, localFile, putExtra, function (err, resBody, res) {
                if (err) {
                    core.error('七牛云上传异常:' + err);
                    throw err;
                }

                if (res.statusCode == 200) {
                    resolve({
                        file,
                        resBody,
                        res,
                        isOverwrite
                    });
                } else {
                    reject({
                        file,
                        resBody,
                        res,
                        isOverwrite
                    });
                }
            });
        });
    }

    /**
     * 获取排除目录集合 - glob使用
     * @param {string,array} dirs 要排除的目录
     * @return {array}
     */
    getIgonres(dirs = '') {
        dirs = dirs.split(',');
        return dirs;
    }

    /**
     * 获取token
     * @param {boolean} overwriteKey 如果是覆盖上传，要传原文件名
     * @return {string}
     */
    getToken(overwriteKey = false) {
        // 如果带有原文件名，则组装成 桶:原文件名 形式 如 bucket:123.jpg
        const scope = overwriteKey ? [this.setting.bucket, overwriteKey].join(':') : this.setting.bucket;
        return  new qiniu.rs.PutPolicy({ scope }).uploadToken(this.mac);
    }

    // 按顺序执行异步队列
    asyncRun(list, options = { callback, errorback }) {
        const next = (index) => {
            if (+index === list.length) {
                return;
            }
            list[index]().then(res => {
                options.callback(res);
            }).catch(err => {
                options.errorback(err);
            }).finally(() => {
                next(++index);
            })
        };
        next(0);
    }
}

new Up2Qn({
    bucket: core.getInput('bucket'),
    zone: core.getInput('zone'),
    AK: core.getInput('access_key'),
    SK: core.getInput('secret_key'),
    localDir: core.getInput('local_dir'),
    localExclude: core.getInput('local_exclude'),
    targetDir: core.getInput('target_dir')
});
