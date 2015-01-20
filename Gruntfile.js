module.exports = function (grunt) {

    grunt.initConfig({
        jshint: {
            all: ['Gruntfile.js', 'lib/**/*.js']
        },
        jsdoc: {
            dist: {
                src: ['lib/**/*.js'],
                options: {
                    destination: 'docs'
                }
            }
        }
    });

    grunt.loadNpmTasks('grunt-contrib-jshint');
    grunt.loadNpmTasks('grunt-browserify');
    grunt.loadNpmTasks('grunt-jsdoc');

    grunt.registerTask('default', 'jshint');
    grunt.registerTask('docs', 'jsdoc');
};