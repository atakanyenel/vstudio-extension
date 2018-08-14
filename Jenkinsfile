#!/usr/bin/env groovy
def label = "kyma-${UUID.randomUUID().toString()}"
def application = 'vscode-plugin'
def isMaster = params.GIT_BRANCH == 'master'

def dockerPushRoot = isMaster 
    ? "${env.DOCKER_REGISTRY}"
    : "${env.DOCKER_REGISTRY}snapshot/"

def dockerImageTag = isMaster
    ? params.APP_VERSION
    : params.GIT_BRANCH

echo """
********************************
Job started with the following parameters:
DOCKER_REGISTRY=${env.DOCKER_REGISTRY}
DOCKER_CREDENTIALS=${env.DOCKER_CREDENTIALS}
GIT_REVISION=${params.GIT_REVISION}
GIT_BRANCH=${params.GIT_BRANCH}
APP_VERSION=${params.APP_VERSION}
APP_FOLDER=${env.APP_FOLDER}
********************************
"""

podTemplate(label: label) {
    node(label) {
        try {
            timestamps {
                timeout(time:20, unit:"MINUTES") {
                    ansiColor('xterm') {
                        stage("setup") {
                            checkout scm

                            if(dockerImageTag == ""){
                               error("No version for docker tag defined, please set APP_VERSION parameter for master branch or GIT_BRANCH parameter for any branch")
                           }

                            withCredentials([usernamePassword(credentialsId: env.DOCKER_CREDENTIALS, passwordVariable: 'pwd', usernameVariable: 'uname')]) {
                                sh "docker login -u $uname -p '$pwd' $env.DOCKER_REGISTRY"
                            }

                            if (isMaster) {
                                ws() {
                                    scriptUrl = 'https://stash.hybris.com/scm/yaasp/pipeline-library.git'
                                    scan = loadModule url: scriptUrl, name: 'scan', branch: 'kyma'
                                }
                            }
                        }


                        stage("build $application") {
                            execute("build.sh")
                        }

                        stage("package $application") {
                            execute("vsce package")
                        }

                        if (isMaster) {
                            stage("IP scan $application (WhiteSource)") {
                                withCredentials([string(credentialsId: 'whitesource_apikey', variable: 'apikey')]) {
                                    execute("make scan", ["API_KEY=$apikey"])
                                }
                            }
                        }

                        if (isMaster) {
                            stage("security scan $application (Checkmarx)"){
                                scan.checkmarx(projectname: "KYMA_" + application.toUpperCase() + "_" + "MASTER", credentialsId: 'checkmarx' )
                            }
                        }
                        

            
                    }
                }
            }
        } catch (ex) {
            echo "Got exception: ${ex}"
            currentBuild.result = "FAILURE"
            def body = "${currentBuild.currentResult} ${env.JOB_NAME}${env.BUILD_DISPLAY_NAME}: on branch: ${params.GIT_BRANCH}. See details: ${env.BUILD_URL}"
            emailext body: body, recipientProviders: [[$class: 'DevelopersRecipientProvider'], [$class: 'CulpritsRecipientProvider'], [$class: 'RequesterRecipientProvider']], subject: "${currentBuild.currentResult}: Job '${env.JOB_NAME} [${env.BUILD_NUMBER}]'"
        }
    }
}

def execute(command, envs = []) {
    def repositoryName = 'monorepo'
    def buildpack = 'node-buildpack:0.0.8'
    def envText = ''
    for (it in envs) {
        envText = "$envText --env $it"
    }
    workDir = pwd()
    sh "docker run --rm -v $workDir:/$repositoryName -w /$repositoryName/$env.APP_FOLDER $envText ${env.DOCKER_REGISTRY}$buildpack /bin/bash -c '$command'"
}