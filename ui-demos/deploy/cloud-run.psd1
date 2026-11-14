@{
    Service = 'oma-talous-ui'
    Region = 'europe-north1'
    RuntimeAccount = 'oma-talous-ui'
    BuildAccount = 'oma-talous-ui-build'
    Cpu = 1
    Memory = '256Mi'
    MinInstances = 0
    MaxInstances = 2
    Concurrency = 80
    TimeoutSeconds = 60
    ChatSecret = 'money-coach-anthropic-key'
    ChatSecretVersion = '1'
}
