/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

var combineCount = 0;
var combineCache = {};
var stable = require("stable");

/**
 * 获取html页面中的<script ... src="path"></script> 资源
 * 获取html页面中的<link ... rel="stylesheet" href="path" /> 资源
 * 由于已经在标准流程之后，无需处理inline
 * 不需要改动页面中内嵌的样式
 * 需要将页面中内嵌的脚本移动到所有脚本的最下方
 * 需要去除注释内的引用
 * @param content
 */
function analyzeHtml(content, pathMap) {
    var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?:<\/script\s*>\s?\r?\n|$)|<(link)\s+[\s\S]*?["'\s\w\/\-](?:>\s?\r?\n|$)|<!--([\s\S]*?)(?:-->\s?\r?\n|$)/ig;
    var match;
    var resources = {
        scripts: [],
        inlineScripts: [],
        styles: []
    };
    var replaced = content.replace(reg, function (m, $1, $2, $3, $4) {
        //$1为script标签, $2为内嵌脚本内容, $3为link标签, $4为注释内容
        if ($1) {
            if ($2) {
                //如果标签设置了data-fixed则不会收集此资源
                if (/(\sdata-fixed\s*=\s*)('true'|"true")/ig.test($1)) {
                    return m;
                }
                resources.inlineScripts.push({content: m });
            } else {
                result = m.match(/(?:\ssrc\s*=\s*)(?:'([^']+)'|"([^"]+)"|[^\s\/>]+)/i);
                if (result && (result[2] || result[3])) {
                    var jsUrl = result[2] || result[3];
                    //不在资源表中的资源不处理
                    if (!pathMap[jsUrl])
                        return m;
                    var single = false;
                    if (/(\sdata-single\s*=\s*)('true'|"true")/ig.test($1)) {
                        single = true;
                    }
                    resources.scripts.push({
                        content: m,
                        id: pathMap[jsUrl],
                        single: single
                    });
                }
            }
        } else if ($3) {
            var isCssLink = false;
            var result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
            if (result && result[1]) {
                var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                isCssLink = rel === 'stylesheet';
            }
            //对rel不是stylesheet的link不处理
            if (!isCssLink)
                return m;
            result = m.match(/(?:\shref\s*=\s*)(?:'([^']+)'|"([^"]+)"|[^\s\/>]+)/i);
            if (result && (result[2] || result[3])) {
                var cssUrl = result[2] || result[3];
                if (!pathMap[cssUrl])
                    return m;
                resources.styles.push({
                    content: m,
                    id: pathMap[cssUrl]
                })
            }
        } else if ($4) {
            //不处理注释
            return m;
        }
        return '';
    });
    return {
        resources: resources,
        content: replaced
    }
}

function getResourcePathMap(ret) {
    var map = {};
    fis.util.map(ret.map.res, function (subpath, file) {
        map[file.uri] = subpath;
    });
    return map
}

/**
 * 将页面依赖的资源与打包资源对比合并
 * @param resources
 * @param ret
 * @param settings
 * @param conf
 * @param opt
 * @returns {Array}
 */
function getPkgResource(resources, ret, settings, conf, opt) {
    var pkgs = {};
    var list = [];
    var handled = {};
    resources.forEach(function (resource) {
        var id = resource.id;
        if (handled[id])
            return false;
        var res = ret.map.res[id];
        handled[id] = true;
        if (res.pkg) {
            if (pkgs[res.pkg])
                return false;
            pkgs[res.pkg] = true;
            list.push({
                type: 'pkg',
                id: res.pkg
            })
        } else {
            list.push({
                type: 'res',
                id: id,
                single: resource.single
            })
        }
    });
    return list;
}

/**
 * 自动打包零散资源
 * @param resList
 * @param ret
 * @param settings
 * @param conf
 * @param opt
 * @returns {Array}
 */
function autoCombine(resList, ret, settings, conf, opt) {
    var list = [];
    var toCombine = [];
    var fileExt;

    function getCombineHash(list){
        var idList = list.map(function(res){
            return res.id;
        });
        var sorted = stable(idList).join(',');
        return sorted;
    }

    function flushCombine() {
        if (toCombine.length == 1) {
            //单独的文件不进行处理
            list.push(toCombine[0]);
            toCombine = [];
            return;
        }
        if (toCombine.length !== 0) {
            var hash = getCombineHash(toCombine);
            var content = '';
            var index = 0;
            var has = [];
            var id;
            if (combineCache[hash]){
                fis.log.debug('auto combine hit cache [' + hash + ']');
                id = combineCache[hash];
            }
            else{
                toCombine.forEach(function (res) {
                    var file = ret.ids[res.id];
                    var c = file.getContent();
                    has.push(file.getId());
                    if (!fileExt) {
                        fileExt = file.isJsLike ? 'js' : 'css';
                    }
                    if (c != '') {
                        if (index++ > 0) {
                            content += '\n';
                            if (file.isJsLike) {
                                content += ';';
                            } else if (file.isCssLike) {
                                c = c.replace(/@charset\s+(?:'[^']*'|"[^"]*"|\S*);?/gi, '');
                            }
                        }
                        content += c;
                    }
                });
                var subpath = 'pkg/auto_combine_${index}'.replace('${index}', combineCount) + '.' + fileExt;
                var file = fis.file(fis.project.getProjectPath(), subpath);
                ret.pkg[file.subpath] = file;
                file.setContent(content);
                id = "auto_" + fileExt + "_" + combineCount;
                ret.map.pkg[id] = {
                    uri: file.getUrl(opt.hash, opt.domain),
                    type: fileExt,
                    has: has
                };
                combineCache[hash] = id;
                combineCount++;
            }
            list.push({
                type: 'pkg',
                id: id
            });
            toCombine = [];
        }
    }

    resList.forEach(function (res) {
        if (res.type === 'pkg') {
            flushCombine();
            list.push(res);
        } else {
            if (res.single) {
                flushCombine();
                list.push(res);
            } else {
                toCombine.push(res);
            }
        }
    });
    flushCombine();
    return list;
}

function injectJs(jsList, content, ret) {
    function getCharset() {
        var charset = fis.config.get('project.charset');
        switch (charset) {
            case 'utf8':
                return 'utf-8';
            default:
                return charset;
        }
    }

    var script = '';
    jsList.forEach(function (js) {
        var uri;
        if (js.type === 'pkg') {
            uri = ret.map.pkg[js.id].uri;
        } else {
            uri = ret.map.res[js.id].uri;
        }
        script += '<script type="text/javascript" charset="' + getCharset() + '" src="' + uri + '"></script>\r\n';
    });
    return content.replace(/<\/body>/, script + '\n$&');
}

function injectCss(cssList, content, ret) {
    var css = '';
    cssList.forEach(function (js) {
        var uri;
        if (js.type === 'pkg') {
            uri = ret.map.pkg[js.id].uri;
        } else {
            uri = ret.map.res[js.id].uri;
        }
        css += '<link rel="stylesheet" href="' + uri + '">\r\n';
    });
    return content.replace(/<\/head>/, css + '\n$&');
}

function injectInlineJs(inlineScripts, content, ret) {
    var inline = '';
    inlineScripts.forEach(function (script) {
        inline += script.content;
    });
    return content.replace(/<\/body>/, inline + '\n$&');
}

module.exports = function (ret, settings, conf, opt) { //打包后处理
    if (!opt.pack)
        return;
    var pathMap = getResourcePathMap(ret);
    fis.util.map(ret.src, function (subpath, file) {
        if (file.isHtmlLike && file.noMapJs !== false) { //类html文件
            var content = file.getContent();
            var result = analyzeHtml(content, pathMap);
            var jsList = getPkgResource(result.resources.scripts, ret);
            var cssList = getPkgResource(result.resources.styles, ret);
            if (conf.autoCombine !== false) {
                jsList = autoCombine(jsList, ret, settings, conf, opt);
                cssList = autoCombine(cssList, ret, settings, conf, opt);
            }
            content = injectJs(jsList, result.content, ret);
            content = injectCss(cssList, content, ret);
            content = injectInlineJs(result.resources.inlineScripts, content, ret);
            file.setContent(content);
        }
    });
};
